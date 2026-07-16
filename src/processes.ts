import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { resolveCommandSync } from "./command-resolution.js";
import { childProxyEnv } from "./proxy.js";

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
  const resolved = resolveCommandSync(command, { env: options.env as NodeJS.ProcessEnv | undefined });
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
