import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

import { resolveCommandSync } from "./command-resolution.js";
import { readJsonFile } from "./file-store.js";
import { childProxyEnv } from "./proxy.js";
import type { ProjectConfig, ResolvedPaths } from "./types.js";

export { runClaudeCode } from "./claude-launcher.js";

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface RunOptions {
  spawn?: SpawnFunction;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const defaultSpawn: SpawnFunction = (command, args, options) => {
  const resolved = resolveCommandSync(command, {
    env: options.env as NodeJS.ProcessEnv | undefined
  });
  return nodeSpawn(resolved.command, [...resolved.prefixArgs, ...args], options);
};

export function runCaptured(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const spawn = options.spawn ?? defaultSpawn;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: childProxyEnv(options.env)
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill(), options.timeoutMs);
      timer.unref();
    }
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export function runAttached(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<number> {
  const spawn = options.spawn ?? defaultSpawn;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
      windowsHide: false,
      env: childProxyEnv(options.env)
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export function runCcrCode(args: readonly string[], options: RunOptions = {}): Promise<number> {
  return runAttached("ccr", ["code", ...args], {
    ...options,
    env: { ...process.env, ...options.env, NODE_NO_WARNINGS: "1" }
  });
}

export interface ShimHealth {
  status: "ok";
  instanceId: string;
  pid: number;
}

export function readShimHealth(port: number, timeoutMs = 1_000): Promise<ShimHealth | undefined> {
  return new Promise((resolve) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/health",
      method: "GET",
      timeout: timeoutMs
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) return resolve(undefined);
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ShimHealth;
          resolve(value.status === "ok" ? value : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    outgoing.once("timeout", () => outgoing.destroy());
    outgoing.once("error", () => resolve(undefined));
    outgoing.end();
  });
}

interface ShimState {
  pid: number;
  port: number;
  instanceId: string;
}

async function readShimState(path: string): Promise<ShimState | undefined> {
  try {
    return await readJsonFile<ShimState>(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface EnsureShimDependencies {
  shimEntry?: string;
  spawnDetached?: (command: string, args: string[]) => void;
  health?: (port: number) => Promise<ShimHealth | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  expectedInstanceId?: () => Promise<string | undefined>;
  timeoutMs?: number;
}

export async function ensureShim(
  config: ProjectConfig,
  paths: ResolvedPaths,
  dependencies: EnsureShimDependencies = {}
): Promise<ShimHealth> {
  const health = dependencies.health ?? readShimHealth;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const expectedInstanceId = dependencies.expectedInstanceId ?? (async () =>
    (await readShimState(paths.shimState))?.instanceId);
  const expectedBefore = await expectedInstanceId();
  const current = await health(config.shimPort);
  if (current && (!expectedBefore || current.instanceId === expectedBefore)) return current;

  const shimEntry = dependencies.shimEntry ?? fileURLToPath(new URL("./shim-main.js", import.meta.url));
  const spawnDetached = dependencies.spawnDetached ?? ((command, args) => {
    const child = nodeSpawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
      env: childProxyEnv()
    });
    child.unref();
  });
  spawnDetached(process.execPath, [shimEntry, "--config", paths.projectConfig]);

  const deadline = Date.now() + (dependencies.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    await sleep(100);
    const [candidate, expected] = await Promise.all([
      health(config.shimPort),
      expectedInstanceId()
    ]);
    if (candidate && expected && candidate.instanceId === expected) return candidate;
  }
  throw new Error(`Shim startup timed out on 127.0.0.1:${config.shimPort}`);
}

function requestShutdown(port: number, secret: string, instanceId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/shutdown",
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-shim-instance": instanceId
      }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 202));
    });
    outgoing.once("error", () => resolve(false));
    outgoing.end();
  });
}

export async function stopShim(
  config: ProjectConfig,
  paths: ResolvedPaths
): Promise<boolean> {
  const state = await readShimState(paths.shimState);
  if (!state) return false;
  const health = await readShimHealth(state.port);
  if (!health || health.instanceId !== state.instanceId) return false;
  const stopped = await requestShutdown(state.port, config.localSecret, state.instanceId);
  if (stopped) await rm(paths.shimState, { force: true });
  return stopped;
}
