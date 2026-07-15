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

export interface CreatePrivateCcrEnvironmentOptions {
  parentEnv?: Readonly<NodeJS.ProcessEnv>;
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

function inheritedEnvironment(parentEnv: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function restrictDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o700);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
}

export async function createPrivateCcrEnvironment(
  options: CreatePrivateCcrEnvironmentOptions = {}
): Promise<PrivateCcrEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "cannbot-cc-ccr-"));
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
    await restrictDirectory(root);
    await Promise.all(Object.values(paths)
      .filter((path) => path !== root)
      .map(async (path) => {
        await mkdir(path, { mode: 0o700, recursive: true });
        await restrictDirectory(path);
      }));
  } catch (error) {
    await rm(root, { force: true, recursive: true });
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
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData
  };

  let disposal: Promise<void> | undefined;
  return {
    env,
    paths,
    dispose: () => {
      disposal ??= rm(root, { force: true, recursive: true });
      return disposal;
    }
  };
}
