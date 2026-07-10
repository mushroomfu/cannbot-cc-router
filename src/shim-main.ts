#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CcrAdapter } from "./ccr-adapter.js";
import { resolveCcrAdapter } from "./default-service.js";
import { readCredentials } from "./credentials.js";
import { readJsonFile, writeJsonAtomic } from "./file-store.js";
import { resolvePaths } from "./paths.js";
import { runCaptured, type RunOptions, type RunResult } from "./processes.js";
import { createShim, type ShimOptions } from "./shim.js";
import type { ProjectConfig } from "./types.js";

const CANNBOT_UPSTREAM =
  "https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions";

type CapturedRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>;

export function parseShimMainArgs(argv: readonly string[]): string {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("shim-main requires --config <path>");
  return value;
}

export async function refreshCannbotCredentials(
  runner: CapturedRunner = runCaptured
): Promise<void> {
  const result = await runner("cannbot", ["models", "cannbot"], {
    timeoutMs: 30_000
  });
  if (result.code !== 0) {
    throw new Error("Cannbot credential validation failed");
  }
}

function validateConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object") throw new Error("Project config must be an object");
  const config = value as Partial<ProjectConfig>;
  if (
    typeof config.model !== "string" ||
    typeof config.shimPort !== "number" ||
    typeof config.localSecret !== "string" ||
    typeof config.proxy !== "string"
  ) throw new Error("Project config is incomplete");
  const models = config.models ?? [config.model];
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some((model) => typeof model !== "string" || model.trim().length === 0)
  ) throw new Error("Project config model catalog is invalid");
  return { ...config, models: [...models], shimHost: "127.0.0.1" } as ProjectConfig;
}

function configPaths(configArgument: string) {
  const configPath = resolve(configArgument);
  const projectDir = dirname(configPath);
  const home = dirname(projectDir);
  return { configPath, paths: resolvePaths({ home }) };
}

export interface LoadShimOptionsDependencies {
  ccr?: CcrAdapter;
}

export async function loadShimOptions(
  configArgument: string,
  dependencies: LoadShimOptionsDependencies = {}
): Promise<ShimOptions> {
  const { configPath, paths } = configPaths(configArgument);
  const config = validateConfig(await readJsonFile(configPath));
  const ccr = dependencies.ccr ?? await resolveCcrAdapter(paths);
  const connection = await ccr.loadConnection();

  return {
    localSecret: config.localSecret,
    models: config.models,
    ccrUrl: connection.baseUrl,
    ...(connection.apiKey ? { ccrApiKey: connection.apiKey } : {}),
    upstreamUrl: CANNBOT_UPSTREAM,
    proxyMode: config.proxy,
    host: "127.0.0.1",
    port: config.shimPort,
    readCredentials: () => readCredentials(paths),
    refreshCredentials: () => refreshCannbotCredentials()
  };
}

export async function runShimMain(configArgument: string): Promise<void> {
  const { paths } = configPaths(configArgument);
  const shim = createShim(await loadShimOptions(configArgument));
  const address = await shim.listen();
  await writeJsonAtomic(paths.shimState, {
    pid: process.pid,
    port: address.port,
    instanceId: shim.instanceId,
    startedAt: new Date().toISOString()
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await shim.close().catch(() => undefined);
    await rm(paths.shimState, { force: true }).catch(() => undefined);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

// Run only when invoked directly as the entry point, not when imported by tests.
// Compare real paths so the check still holds when this module is reached through
// a symlink (see cli.ts for the same guard).
const invokedPath = process.argv[1];
function isMainEntry(invoked: string | undefined): boolean {
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(invoked).href;
  }
}
if (isMainEntry(invokedPath)) {
  try {
    await runShimMain(parseShimMainArgs(process.argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
