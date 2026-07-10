import { runCaptured, type RunOptions, type RunResult } from "./processes.js";

export type CcrMajorVersion = 2 | 3;

export type CcrVersionRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>;

const VERSION = /\b(?:claude-code-router\s+)?version\s*:\s*v?(\d+)(?:\.\d+){1,2}\b/i;

export function parseCcrVersion(output: string): CcrMajorVersion {
  const match = VERSION.exec(output);
  if (!match) {
    throw new Error("Unable to determine CCR version; run `ccr version`");
  }
  const major = Number(match[1]);
  if (major === 2 || major === 3) return major;
  throw new Error(`Unsupported CCR major version ${major}; supported versions are 2 and 3`);
}

export async function detectCcrVersion(
  runner: CcrVersionRunner = runCaptured
): Promise<CcrMajorVersion> {
  const result = await runner("ccr", ["version"], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new Error("Unable to determine CCR version; run `ccr version`");
  }
  return parseCcrVersion(`${result.stdout}\n${result.stderr}`);
}