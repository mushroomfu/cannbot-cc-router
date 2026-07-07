import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface CommandResolution {
  command: string;
  prefixArgs: string[];
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
  const match = source.match(/%dp0%[\\/]([^"\r\n]+?\.(?:[cm]?js))/i);
  if (!match) return undefined;
  const entry = resolve(dirname(path), match[1].replace(/[\\/]/g, sep));
  return existsSync(entry) ? entry : undefined;
}

export function resolveCommandSync(
  command: string,
  options: ResolveCommandOptions = {}
): CommandResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") return { command, prefixArgs: [] };

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
    if (entry) return { command: process.execPath, prefixArgs: [entry] };
  }
  return { command, prefixArgs: [] };
}

export async function resolveCommand(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<CommandResolution> {
  return resolveCommandSync(command, options);
}
