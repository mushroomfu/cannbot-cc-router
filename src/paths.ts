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
  const v2Dir = join(home, ".claude-code-router");
  const internalHome = env.CCR_INTERNAL_HOME_DIR?.trim() || undefined;
  const internalAppData = env.CCR_INTERNAL_APP_DATA_DIR?.trim() || undefined;
  const internalUserData = env.CCR_INTERNAL_USER_DATA_DIR?.trim() || undefined;
  const v3Dir = platform === "win32"
    ? join(internalAppData ?? env.APPDATA ?? join(home, "AppData", "Roaming"), "claude-code-router")
    : join(internalHome ?? home, ".claude-code-router");
  const v3UserData = internalUserData ?? (platform === "win32"
    ? v3Dir
    : join(v3Dir, "app-data"));
  const ccrV2Config = join(v2Dir, "config.json");
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
    ccrConfig: ccrV2Config,
    ccrV2Config,
    ccrV3ConfigDb: join(v3Dir, "config.sqlite"),
    ccrV3GatewayConfig: join(v3Dir, "gateway.config.json"),
    ccrV3ApiKeysDb: join(v3UserData, "api-keys.sqlite"),
    openCodeAuthCandidates: unique(candidates)
  };
}
