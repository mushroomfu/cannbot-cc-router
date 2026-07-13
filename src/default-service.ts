import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { connect } from "node:net";

import { reconcileCcrConfig } from "./ccr-config.js";
import type { CcrAdapter } from "./ccr-adapter.js";
import { CcrV2Adapter } from "./ccr-v2-adapter.js";
import { CcrV3Adapter } from "./ccr-v3-adapter.js";
import { detectCcrVersion } from "./ccr-version.js";
import {
  ccrStatus,
  checkExecutable,
  restartCcr,
  startCcr,
  stopCcr
} from "./ccr-processes.js";
import { readCredentials } from "./credentials.js";
import { runDoctor, type DoctorDependencies, type DoctorReport } from "./doctor.js";
import { backupOnce, readJsonFile, writeJsonAtomic } from "./file-store.js";
import { resolvePaths } from "./paths.js";
import {
  ensureShim,
  readShimHealth,
  runCaptured,
  runClaudeCode,
  stopShim,
  type RunOptions,
  type RunResult
} from "./processes.js";
import { selectProxy } from "./proxy.js";
import { RouterService, type InitOptions } from "./router-service.js";
import type { ProjectConfig, ResolvedPaths } from "./types.js";

const CANNBOT_UPSTREAM =
  "https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions";

export type CapturedRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>;

export function parseCannbotModels(output: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("cannbot/")) continue;
    const model = line.slice("cannbot/".length);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

export async function listCannbotModels(
  runner: CapturedRunner = runCaptured
): Promise<string[]> {
  const result = await runner("cannbot", ["models", "cannbot"], {
    timeoutMs: 30_000
  });
  const models = parseCannbotModels(result.stdout);
  if (result.code !== 0 || models.length === 0) {
    throw new Error("Unable to query Cannbot models");
  }
  return models;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object") throw new Error("Project config must be an object");
  const config = value as Partial<ProjectConfig>;
  if (
    typeof config.model !== "string" ||
    typeof config.shimPort !== "number" ||
    typeof config.localSecret !== "string" ||
    typeof config.proxy !== "string"
  ) throw new Error("Project config is incomplete; run `cannbot-cc init`");
  const models = config.models ?? [config.model];
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((model) => typeof model !== "string" || model.trim().length === 0)
  ) {
    throw new Error("Project config model catalog is invalid; run `cannbot-cc sync`");
  }
  return { ...config, models: [...models], shimHost: "127.0.0.1" } as ProjectConfig;
}

export async function loadProjectConfig(paths: ResolvedPaths): Promise<ProjectConfig> {
  return validateProjectConfig(await readJsonFile(paths.projectConfig));
}

export interface InitializeProjectDependencies {
  paths: ResolvedPaths;
  listModels?: () => Promise<string[]>;
  secret?: () => string;
  ccr?: CcrAdapter;
}

export async function initializeProject(
  options: InitOptions,
  dependencies: InitializeProjectDependencies
): Promise<ProjectConfig> {
  const { paths } = dependencies;
  const ccrAdapter = dependencies.ccr ?? await resolveCcrAdapter(paths);
  if (!Number.isInteger(options.shimPort) || options.shimPort < 1 || options.shimPort > 65_535) {
    throw new Error("Shim port must be an integer from 1 to 65535");
  }
  await readCredentials(paths);
  const models = await (dependencies.listModels ?? listCannbotModels)();
  if (!models.includes(options.model)) {
    throw new Error(`Cannbot model is not available: ${options.model}`);
  }

  let previous: ProjectConfig | undefined;
  if (await exists(paths.projectConfig)) {
    previous = await loadProjectConfig(paths);
  }
  const ccrExists = ccrAdapter.major === 2 && await exists(paths.ccrV2Config);
  const ccrBackup = previous?.ccrBackup ?? (ccrExists ? await backupOnce(paths.ccrV2Config) : undefined);
  const config: ProjectConfig = {
    model: options.model,
    models: [...models],
    shimHost: "127.0.0.1",
    shimPort: options.shimPort,
    localSecret: previous?.localSecret ?? (dependencies.secret ?? (() => randomBytes(32).toString("base64url")))(),
    proxy: options.proxy,
    managedRoutes: options.setDefault || previous?.managedRoutes === true,
    ...(ccrBackup ? { ccrBackup } : {})
  };
  await ccrAdapter.reconcile({
    shimPort: config.shimPort,
    localSecret: config.localSecret,
    model: config.model,
    models: config.models,
    setDefault: options.setDefault
  });
  await writeJsonAtomic(paths.projectConfig, config);
  return config;
}

async function reconcileProject(
  config: ProjectConfig,
  paths: ResolvedPaths,
  setDefault: boolean,
  ccrAdapter: CcrAdapter
): Promise<void> {
  const models = await listCannbotModels();
  if (!models.includes(config.model)) {
    throw new Error(`Cannbot model is not available: ${config.model}`);
  }
  const ccrExists = ccrAdapter.major === 2 && await exists(paths.ccrV2Config);
  const nextConfig: ProjectConfig = {
    ...config,
    models: [...models],
    managedRoutes: config.managedRoutes === true || setDefault
  };
  if (!nextConfig.ccrBackup && ccrExists) {
    nextConfig.ccrBackup = await backupOnce(paths.ccrV2Config);
  }
  await ccrAdapter.reconcile({
    shimPort: nextConfig.shimPort,
    localSecret: nextConfig.localSecret,
    model: nextConfig.model,
    models: nextConfig.models,
    setDefault
  });
  await writeJsonAtomic(paths.projectConfig, nextConfig);
}

export async function resolveCcrAdapter(paths: ResolvedPaths): Promise<CcrAdapter> {
  const detected = await detectCcrVersion();
  return detected.major === 2 ? new CcrV2Adapter(paths) : new CcrV3Adapter({ paths });
}
export function createDefaultRouterService(
  paths: ResolvedPaths = resolvePaths()
): RouterService {
  const adapter = resolveCcrAdapter(paths);
  return new RouterService({
    initialize: async (options) => initializeProject(options, { paths, ccr: await adapter }),
    loadConfig: () => loadProjectConfig(paths),
    validateCredentials: async () => { await readCredentials(paths); },
    reconcile: async (config, setDefault) => reconcileProject(config, paths, setDefault, await adapter),
    prepareCcrForReconcile: async () => {
      const selected = await adapter;
      if (selected.major !== 3 || !await selected.status()) return;
      if (!await selected.stop()) {
        throw new Error("CCR v3 must stop before synchronizing configuration");
      }
    },
    ensureShim: async (config) => { await ensureShim(config, paths); },
    startCcr: async () => { await (await adapter).start(); },
    stopShim: (config) => stopShim(config, paths),
    stopCcr: async () => (await adapter).stop(),
    restartCcr: async () => (await adapter).restart(),
    shimStatus: async (config) => Boolean(await readShimHealth(config.shimPort)),
    ccrStatus: async () => (await adapter).status(),
    runClaudeCode
  });
}

function probeTcp(url: string, timeoutMs = 2_000): Promise<void> {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port });
    const timer = setTimeout(() => socket.destroy(new Error("connection timeout")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createDefaultDoctorDependencies(
  paths: ResolvedPaths = resolvePaths()
): DoctorDependencies {
  const adapter = resolveCcrAdapter(paths);
  return {
    nodeVersion: () => process.versions.node,
    executable: async (name) => {
      if (name !== "ccr") return checkExecutable(name, ["--version"]);
      try {
        await detectCcrVersion();
        return true;
      } catch { return false; }
    },
    ccrVersion: () => detectCcrVersion(),
    credentials: async () => { await readCredentials(paths); },
    ccrConfig: async () => {
      const [project, credentials, selected] = await Promise.all([
        loadProjectConfig(paths),
        readCredentials(paths),
        adapter
      ]);
      const source = JSON.stringify(project);
      if (source.includes(credentials.virtualKey)) {
        throw new Error("Cannbot credentials leaked into generated configuration");
      }
      await selected.validateManagedState(project);
    },
    proxy: async () => {
      const config = await loadProjectConfig(paths);
      const selected = selectProxy(CANNBOT_UPSTREAM, config.proxy);
      if (selected) await probeTcp(selected);
      return selected;
    },
    upstream: async () => {
      try {
        return (await listCannbotModels()).length > 0;
      } catch {
        return false;
      }
    },
    shim: async () => {
      try {
        const config = await loadProjectConfig(paths);
        return Boolean(await readShimHealth(config.shimPort));
      } catch {
        return false;
      }
    },
    ccr: async () => (await adapter).status()
  };
}

export function runDefaultDoctor(paths: ResolvedPaths = resolvePaths()): Promise<DoctorReport> {
  return runDoctor(createDefaultDoctorDependencies(paths));
}
