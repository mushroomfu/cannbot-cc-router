import { randomBytes } from "node:crypto";

import { readCredentials } from "./credentials.js";
import { runDoctor, type DoctorDependencies, type DoctorReport } from "./doctor.js";
import { readJsonFile } from "./file-store.js";
import { resolvePaths } from "./paths.js";
import { runPrivateClaudeCodeSession } from "./private-code-session.js";
import { resolveBundledCcrArtifact } from "./private-ccr-session.js";
import { loadOrCreateProjectConfig, type ProjectConfigBootstrapDependencies } from "./project-config.js";
import { runCaptured, type RunOptions, type RunResult } from "./processes.js";
import { selectProxy } from "./proxy.js";
import { RouterService } from "./router-service.js";
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
  const result = await runner("cannbot", ["models", "cannbot"], { timeoutMs: 30_000 });
  const models = parseCannbotModels(result.stdout);
  if (result.code !== 0 || models.length === 0) {
    throw new Error("Unable to query Cannbot models");
  }
  return models;
}

export function createDefaultRouterService(
  paths: ResolvedPaths = resolvePaths(),
  privateCodeRunner: typeof runPrivateClaudeCodeSession = runPrivateClaudeCodeSession,
  projectBootstrap: ProjectConfigBootstrapDependencies = {
    listModels: () => listCannbotModels(),
    secret: () => randomBytes(32).toString("base64url")
  }
): RouterService {
  return new RouterService({
    runPrivateClaudeCode: (args, options = {}) => privateCodeRunner(args, options, {
      loadConfig: () => loadOrCreateProjectConfig(paths, projectBootstrap),
      readCredentials: () => readCredentials(paths),
      refreshCredentials: async () => { await listCannbotModels(); },
      validateCredentials: async () => { await readCredentials(paths); }
    })
  });
}

async function checkExecutable(name: "cannbot" | "claude"): Promise<boolean> {
  try {
    return (await runCaptured(name, ["--version"], { timeoutMs: 10_000 })).code === 0;
  } catch {
    return false;
  }
}

export function createDefaultDoctorDependencies(
  paths: ResolvedPaths = resolvePaths()
): DoctorDependencies {
  return {
    nodeVersion: () => process.versions.node,
    executable: checkExecutable,
    ccrVersion: async () => (await resolveBundledCcrArtifact()).version,
    credentials: async () => { await readCredentials(paths); },
    projectConfig: async () => { await readJsonFile<ProjectConfig>(paths.projectConfig); },
    proxy: async () => {
      const config = await readJsonFile<ProjectConfig>(paths.projectConfig);
      return selectProxy(CANNBOT_UPSTREAM, config.proxy);
    },
    upstream: async () => {
      try { return (await listCannbotModels()).length > 0; } catch { return false; }
    }
  };
}

export function runDefaultDoctor(paths: ResolvedPaths = resolvePaths()): Promise<DoctorReport> {
  return runDoctor(createDefaultDoctorDependencies(paths));
}
