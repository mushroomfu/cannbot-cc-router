import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCommandSync } from "./command-resolution.js";
import { mergeNoProxy } from "./proxy.js";
import type { ProjectConfig } from "./types.js";

export type ClaudeSpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type ContextWindow = "200k" | "1m";

export interface RunClaudeOptions {
  spawn?: ClaudeSpawnFunction;
  env?: NodeJS.ProcessEnv;
  contextWindow?: ContextWindow;
}

const defaultSpawn: ClaudeSpawnFunction = (command, args, options) => {
  const resolved = resolveCommandSync(command, {
    env: options.env as NodeJS.ProcessEnv | undefined
  });
  return nodeSpawn(resolved.command, [...resolved.prefixArgs, ...args], options);
};

export function apiKeyHelperCommand(nodePath: string, helperPath: string): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(nodePath)} ${quote(helperPath)}`;
}

const CLAUDE_CHILD_PASSTHROUGH = new Set([
  "ALL_PROXY",
  "COMSPEC",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "WINDIR"
]);

function privateClaudeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  directory: string,
  noProxy: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && CLAUDE_CHILD_PASSTHROUGH.has(name.toUpperCase())) {
      env[name] = value;
    }
  }
  const appData = join(directory, "app-data");
  const temp = join(directory, "temp");
  return {
    ...env,
    APPDATA: appData,
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    HOME: directory,
    LOCALAPPDATA: appData,
    NODE_NO_WARNINGS: "1",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "xdg-config"),
    XDG_DATA_HOME: join(directory, "xdg-data")
  };
}


function hasExplicitClaudeModel(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));
}

function runAttached(
  command: string,
  args: readonly string[],
  options: RunClaudeOptions,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const spawn = options.spawn ?? defaultSpawn;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
      windowsHide: false,
      env
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runClaudeCode(
  args: readonly string[],
  config: ProjectConfig,
  options: RunClaudeOptions = {}
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "cannbot-cc-"));
  const settingsPath = join(directory, "settings.json");
  const helperPath = join(directory, "api-key-helper.mjs");
  const parentEnv = options.env ?? process.env;
  const noProxy = mergeNoProxy([parentEnv.NO_PROXY, parentEnv.no_proxy].filter(Boolean).join(","));
  const oneMillionContext = options.contextWindow === "1m";
  const contextModel = `anthropic/cannbot/${config.model}[1m]`;
  const settings = {
    apiKeyHelper: apiKeyHelperCommand(process.execPath, helperPath),
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.shimPort}`,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
      NO_PROXY: noProxy,
      DISABLE_TELEMETRY: "true",
      DISABLE_COST_WARNINGS: "true",
      API_TIMEOUT_MS: "600000",
      ...(oneMillionContext ? {
        ANTHROPIC_DEFAULT_OPUS_MODEL: contextModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: contextModel
      } : {})
    }
  };
  const claudeArgs = oneMillionContext && !hasExplicitClaudeModel(args)
    ? [...args, "--model", "sonnet[1m]"]
    : [...args];

  try {
    await writeFile(
      helperPath,
      `process.stdout.write(${JSON.stringify(config.localSecret)});\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    return await runAttached(
      "claude",
      [...claudeArgs, "--settings", settingsPath],
      options,
      privateClaudeChildEnv(parentEnv, directory, noProxy)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
