import { spawn } from "node:child_process";

import { resolveCommandSync } from "./command-resolution.js";
import { runCaptured, type RunOptions } from "./processes.js";
import { childProxyEnv } from "./proxy.js";

export async function checkExecutable(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<boolean> {
  try {
    return (await runCaptured(command, args, {
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000
    })).code === 0;
  } catch {
    return false;
  }
}

export async function ccrStatus(options: RunOptions = {}): Promise<boolean> {
  try {
    const result = await runCaptured("ccr", ["status"], {
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000
    });
    return result.code === 0 && /Status:\s*Running/i.test(result.stdout);
  } catch {
    return false;
  }
}

export interface StartCcrDependencies {
  spawnDetached?: (command: string, args: readonly string[]) => void;
  status?: () => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export async function startCcr(
  dependencies: StartCcrDependencies = {}
): Promise<void> {
  const status = dependencies.status ?? (() => ccrStatus());
  if (await status()) return;

  const spawnDetached = dependencies.spawnDetached ?? ((command, args) => {
    const env = childProxyEnv();
    const resolved = resolveCommandSync(command, { env });
    const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
      env
    });
    child.unref();
  });
  spawnDetached("ccr", ["start"]);

  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (dependencies.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    await sleep(200);
    if (await status()) return;
  }
  throw new Error("CCR startup timed out");
}

export async function stopCcr(options: RunOptions = {}): Promise<boolean> {
  try {
    return (await runCaptured("ccr", ["stop"], {
      ...options,
      timeoutMs: options.timeoutMs ?? 15_000
    })).code === 0;
  } catch {
    return false;
  }
}

export interface RestartCcrOptions extends RunOptions {
  status?: () => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function restartCcr(options: RestartCcrOptions = {}): Promise<boolean> {
  let result;
  try {
    result = await runCaptured("ccr", ["restart"], {
      ...options,
      timeoutMs: options.timeoutMs ?? 15_000
    });
  } catch {
    return false;
  }
  if (result.code !== 0) return false;
  const status = options.status ?? (() => ccrStatus(options));
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await status()) return true;
    await sleep(200);
  }
  return false;
}

export type { SpawnFunction } from "./processes.js";
