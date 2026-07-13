import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CommandResolution {
  command: string;
  prefixArgs: string[];
  entry?: string;
}

export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function npmEntryFromCmd(path: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const base = dirname(path);
  for (const match of source.matchAll(/%dp0%[\\/]([^"\r\n]+)(?=")/gi)) {
    const entry = resolve(base, match[1].replace(/[\\/]/g, sep));
    const childPath = relative(base, entry);
    const firstSegment = childPath.split(sep)[0]?.toLowerCase();
    if (
      childPath.startsWith("..") ||
      isAbsolute(childPath) ||
      firstSegment !== "node_modules" ||
      !existsSync(entry)
    ) continue;
    return entry;
  }
  return undefined;
}

export function resolveCommandSync(
  command: string,
  options: ResolveCommandOptions = {}
): CommandResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    const pathValue = environmentValue(env, "PATH") ?? "";
    const candidates = isAbsolute(command)
      ? [command]
      : pathValue.split(":").filter(Boolean).map((directory) => join(directory, command));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const entry = realpathSync(candidate);
        return { command, prefixArgs: [], entry };
      } catch {
        return { command, prefixArgs: [] };
      }
    }
    return { command, prefixArgs: [] };
  }

  const pathValue = environmentValue(env, "PATH") ?? "";
  const directories = pathValue.split(";").filter(Boolean);
  if (isAbsolute(command)) directories.unshift(dirname(command));
  const baseName = isAbsolute(command) ? command : undefined;

  for (const directory of directories) {
    const executable = baseName ?? join(directory, `${command}.exe`);
    if (existsSync(executable)) return { command: executable, prefixArgs: [] };
    const cmd = baseName ? `${command}.cmd` : join(directory, `${command}.cmd`);
    if (!existsSync(cmd)) continue;
    const entry = npmEntryFromCmd(cmd);
    if (entry && extname(entry).toLowerCase() === ".exe") {
      return { command: entry, prefixArgs: [] };
    }
    if (entry) return { command: process.execPath, prefixArgs: [entry], entry };
  }
  return { command, prefixArgs: [] };
}

export async function resolveCommand(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<CommandResolution> {
  return resolveCommandSync(command, options);
}
