import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PrivateCcrPaths {
  readonly appData: string;
  readonly home: string;
  readonly root: string;
  readonly temp: string;
  readonly userData: string;
  readonly xdgConfig: string;
  readonly xdgData: string;
}

export interface PrivateCcrEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: PrivateCcrPaths;
  dispose(): Promise<void>;
}

export interface PrivateCcrFilesystem {
  chmod(path: string, mode: number): Promise<void>;
  mkdir(
    path: string,
    options: { mode: number; recursive: true }
  ): Promise<string | undefined>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, options: { force: true; recursive: true }): Promise<void>;
}

export interface PrivateCcrEnvironmentDependencies {
  readonly filesystem?: Partial<PrivateCcrFilesystem>;
  readonly platform?: NodeJS.Platform;
  readonly temporaryDirectory?: () => string;
}

export interface CreatePrivateCcrEnvironmentOptions {
  parentEnv?: Readonly<NodeJS.ProcessEnv>;
  dependencies?: PrivateCcrEnvironmentDependencies;
}

const INHERITED_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "COMSPEC",
  "ComSpec",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "Path",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;

const DEFAULT_FILESYSTEM: PrivateCcrFilesystem = {
  chmod: async (path, mode) => chmod(path, mode),
  mkdir: async (path, options) => mkdir(path, options),
  mkdtemp: async (prefix) => mkdtemp(prefix),
  rm: async (path, options) => rm(path, options)
};

function inheritedEnvironment(parentEnv: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function restrictDirectory(
  path: string,
  filesystem: PrivateCcrFilesystem,
  platform: NodeJS.Platform
): Promise<void> {
  if (platform === "win32") return;
  try {
    await filesystem.chmod(path, 0o700);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
}

export async function createPrivateCcrEnvironment(
  options: CreatePrivateCcrEnvironmentOptions = {}
): Promise<PrivateCcrEnvironment> {
  const filesystem: PrivateCcrFilesystem = { ...DEFAULT_FILESYSTEM, ...options.dependencies?.filesystem };
  const platform = options.dependencies?.platform ?? process.platform;
  const temporaryDirectory = options.dependencies?.temporaryDirectory ?? tmpdir;
  const root = await filesystem.mkdtemp(join(temporaryDirectory(), "cannbot-cc-ccr-"));
  const paths: PrivateCcrPaths = {
    appData: join(root, "app-data"),
    home: join(root, "home"),
    root,
    temp: join(root, "tmp"),
    userData: join(root, "user-data"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data")
  };

  try {
    await restrictDirectory(root, filesystem, platform);
    for (const path of Object.values(paths)) {
      if (path === root) continue;
      await filesystem.mkdir(path, { mode: 0o700, recursive: true });
      await restrictDirectory(path, filesystem, platform);
    }
  } catch (error) {
    try {
      await filesystem.rm(root, { force: true, recursive: true });
    } catch {
      // Preserve the initialization error even when best-effort cleanup also fails.
    }
    throw error;
  }

  const env: NodeJS.ProcessEnv = {
    ...inheritedEnvironment(options.parentEnv ?? process.env),
    APPDATA: paths.appData,
    CCR_INTERNAL_APP_DATA_DIR: paths.appData,
    CCR_INTERNAL_HOME_DIR: paths.home,
    CCR_INTERNAL_USER_DATA_DIR: paths.userData,
    HOME: paths.home,
    LOCALAPPDATA: paths.appData,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData
  };

  let disposal: Promise<void> | undefined;
  return {
    env,
    paths,
    dispose: () => {
      disposal ??= filesystem.rm(root, { force: true, recursive: true });
      return disposal;
    }
  };
}
