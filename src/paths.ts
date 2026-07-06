import { homedir } from "node:os";
import { join } from "node:path";

import type { ResolvedPaths } from "./types.js";

export interface ResolvePathOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function resolvePaths(options: ResolvePathOptions = {}): ResolvedPaths {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const projectDir = join(home, ".cannbot-cc-router");
  const candidates = [
    join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "auth.json")
  ];

  if (platform === "win32" && env.APPDATA) {
    candidates.push(join(env.APPDATA, "opencode", "auth.json"));
  }
  if (platform === "darwin") {
    candidates.push(join(home, "Library", "Application Support", "opencode", "auth.json"));
  }

  return {
    home,
    projectDir,
    projectConfig: join(projectDir, "config.json"),
    shimState: join(projectDir, "shim-state.json"),
    ccrConfig: join(home, ".claude-code-router", "config.json"),
    cannbotSession: join(home, ".cannbot", "session.json"),
    openCodeAuthCandidates: unique(candidates)
  };
}
