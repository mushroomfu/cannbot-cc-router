#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export async function loadShimOptions(configArgument: string): Promise<ShimOptions> {
  const { configPath, paths } = configPaths(configArgument);
  const config = validateConfig(await readJsonFile(configPath));
  const rawCcr = await readJsonFile<unknown>(paths.ccrConfig);
  if (!rawCcr || typeof rawCcr !== "object" || Array.isArray(rawCcr)) {
    throw new Error("CCR configuration must be an object");
  }
  const ccr = rawCcr as Record<string, unknown>;
  const ccrPort = ccr.PORT ?? 3456;
  if (
    typeof ccrPort !== "number" ||
    !Number.isInteger(ccrPort) ||
    ccrPort < 1 ||
    ccrPort > 65_535
  ) throw new Error("CCR port must be an integer from 1 to 65535");
  if (ccr.APIKEY !== undefined && typeof ccr.APIKEY !== "string") {
    throw new Error("CCR APIKEY must be a string");
  }

  return {
    localSecret: config.localSecret,
    models: config.models,
    ccrUrl: `http://127.0.0.1:${ccrPort}`,
    ...(typeof ccr.APIKEY === "string" ? { ccrApiKey: ccr.APIKEY } : {}),
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

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await runShimMain(parseShimMainArgs(process.argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
