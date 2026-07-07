#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readCredentials } from "./credentials.js";
import { readJsonFile, writeJsonAtomic } from "./file-store.js";
import { resolvePaths } from "./paths.js";
import { runCaptured, type RunOptions, type RunResult } from "./processes.js";
import { createShim } from "./shim.js";
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
  return { ...config, shimHost: "127.0.0.1" } as ProjectConfig;
}

export async function runShimMain(configArgument: string): Promise<void> {
  const configPath = resolve(configArgument);
  const projectDir = dirname(configPath);
  const home = dirname(projectDir);
  const paths = resolvePaths({ home });
  const config = validateConfig(await readJsonFile(configPath));
  const shim = createShim({
    localSecret: config.localSecret,
    upstreamUrl: CANNBOT_UPSTREAM,
    proxyMode: config.proxy,
    host: "127.0.0.1",
    port: config.shimPort,
    readCredentials: () => readCredentials(paths),
    refreshCredentials: () => refreshCannbotCredentials()
  });
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
