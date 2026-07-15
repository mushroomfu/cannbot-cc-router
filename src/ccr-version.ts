import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveCommand, type CommandResolution } from "./command-resolution.js";
import { runCaptured, type RunOptions, type RunResult } from "./processes.js";

export type CcrMajorVersion = 2 | 3;
export interface DetectedCcrVersion {
  major: CcrMajorVersion;
  version: string;
}


export type CcrVersionRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>;

export interface DetectCcrVersionDependencies {
  env?: NodeJS.ProcessEnv;
  resolve?: (command: string, options?: { env?: NodeJS.ProcessEnv }) => Promise<CommandResolution>;
  run?: CcrVersionRunner;
}

const VERSION_OUTPUT = /\b(?:claude-code-router\s+)?version\s*:\s*v?(\d+\.\d+\.\d+)\b/i;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const PACKAGE_NAME = "@musistudio/claude-code-router";

export function parseSupportedCcrVersion(version: string): DetectedCcrVersion {
  const match = SEMVER.exec(version);
  if (!match) throw new Error("Unable to determine CCR version");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 3 && minor === 0 && patch >= 0 && patch <= 13) {
    return { major, version };
  }
  throw new Error(`Unsupported CCR version ${version}; supported versions are CCR 3.0.0 through 3.0.13`);
}

export function parseCcrVersion(output: string): CcrMajorVersion {
  const match = VERSION_OUTPUT.exec(output);
  if (!match) throw new Error("Unable to determine CCR version");
  return parseSupportedCcrVersion(match[1]).major;
}

function packageVersionFromEntry(entry: string | undefined): string | undefined {
  if (!entry) return undefined;
  let directory = dirname(entry);
  while (true) {
    const metadataPath = join(directory, "package.json");
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { name?: unknown; version?: unknown };
        if (metadata.name === PACKAGE_NAME && typeof metadata.version === "string") return metadata.version;
      } catch {
        // Continue to a parent package boundary or the legacy command probe.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function detectCcrVersion(
  input: CcrVersionRunner | DetectCcrVersionDependencies = {}
): Promise<DetectedCcrVersion> {
  const runnerOnly = typeof input === "function";
  const dependencies = runnerOnly ? { run: input } : input;
  const resolve = dependencies.resolve ?? (runnerOnly
    ? async (command: string): Promise<CommandResolution> => ({ command, prefixArgs: [] })
    : resolveCommand);
  const runner = dependencies.run ?? runCaptured;
  const resolved = await resolve("ccr", { env: dependencies.env });
  const packageVersion = packageVersionFromEntry(resolved.entry ?? resolved.prefixArgs[0]);
  if (packageVersion) return parseSupportedCcrVersion(packageVersion);

  const result = await runner("ccr", ["version"], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new Error("Unable to determine CCR version from the installed package or `ccr version`");
  }
  const match = VERSION_OUTPUT.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) throw new Error("Unable to determine CCR version");
  return parseSupportedCcrVersion(match[1]);
}
