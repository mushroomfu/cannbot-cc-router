import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import * as processes from "../src/processes.js";
import { apiKeyHelperCommand } from "../src/claude-launcher.js";
import type { SpawnFunction } from "../src/processes.js";
import type { ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  model: "glm-5.2",
  models: ["deepseek-v4-pro", "glm-5.2"],
  shimHost: "127.0.0.1",
  shimPort: 8787,
  localSecret: "local-secret",
  proxy: "auto"
};

test("launches Claude with temporary gateway discovery settings", async () => {
  let command = "";
  let args: readonly string[] = [];
  let options: SpawnOptions | undefined;
  let settingsPath = "";
  let settings: { apiKeyHelper: string; env: Record<string, string> } | undefined;
  let helperCommand = "";
  let helperOutput = "";
  const spawn = ((receivedCommand, receivedArgs, receivedOptions) => {
    command = receivedCommand;
    args = receivedArgs;
    options = receivedOptions;
    const settingsIndex = receivedArgs.lastIndexOf("--settings");
    settingsPath = receivedArgs[settingsIndex + 1];
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      apiKeyHelper: string;
      env: Record<string, string>;
    };
    helperCommand = settings.apiKeyHelper;
    const match = /^"([^"]+)" "([^"]+)"$/.exec(helperCommand);
    assert.ok(match);
    helperOutput = execFileSync(match[1], [match[2]], { encoding: "utf8" }).trim();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: null, stdout: null, stderr: null, kill: () => true });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as SpawnFunction;

  const runClaudeCode = (processes as unknown as {
    runClaudeCode(
      args: readonly string[],
      config: ProjectConfig,
      options: { spawn: SpawnFunction; env: NodeJS.ProcessEnv }
    ): Promise<number>;
  }).runClaudeCode;

  assert.equal(typeof runClaudeCode, "function");
  assert.equal(await runClaudeCode(
    ["-p", "hello world", "--allowedTools", "Read"],
    config,
    { spawn, env: { NO_PROXY: "internal.example" } }
  ), 0);
  assert.equal(command, "claude");
  assert.deepEqual(args.slice(0, 4), ["-p", "hello world", "--allowedTools", "Read"]);
  assert.equal(args.at(-2), "--settings");
  assert.equal(options?.shell, false);
  assert.equal(options?.stdio, "inherit");
  assert.equal(settings?.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(settings?.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(helperOutput, "local-secret");
  assert.match(helperCommand, /api-key-helper\.mjs/);
  assert.equal(settings?.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(settings?.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "");
  assert.match(settings?.env.NO_PROXY ?? "", /internal\.example/);
  assert.match(settings?.env.NO_PROXY ?? "", /localhost/);
  assert.match(settings?.env.NO_PROXY ?? "", /127\.0\.0\.1/);
  assert.equal(existsSync(settingsPath), false);
  assert.equal(options?.env?.NODE_NO_WARNINGS, "1");
});

test("quotes API-key helper paths for Windows and POSIX launchers", async () => {
  assert.equal(
    apiKeyHelperCommand("C:\\Program Files\\node.exe", "C:\\Temp Dir\\api-key-helper.mjs"),
    '"C:\\Program Files\\node.exe" "C:\\Temp Dir\\api-key-helper.mjs"'
  );
  assert.equal(
    apiKeyHelperCommand("/opt/node bin/node", "/tmp/helper dir/api-key-helper.mjs"),
    '"/opt/node bin/node" "/tmp/helper dir/api-key-helper.mjs"'
  );
});

test("launches the selected Cannbot model with Claude's 1M context alias", async () => {
  let args: readonly string[] = [];
  let settings: { env: Record<string, string> } | undefined;
  const spawn = ((_command, receivedArgs) => {
    args = receivedArgs;
    const settingsIndex = receivedArgs.lastIndexOf("--settings");
    settings = JSON.parse(readFileSync(receivedArgs[settingsIndex + 1], "utf8")) as {
      env: Record<string, string>;
    };
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: null, stdout: null, stderr: null, kill: () => true });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as SpawnFunction;

  const runClaudeCode = (processes as unknown as {
    runClaudeCode(
      args: readonly string[],
      config: ProjectConfig,
      options: { spawn: SpawnFunction; contextWindow: "1m" }
    ): Promise<number>;
  }).runClaudeCode;

  assert.equal(await runClaudeCode(["-p", "hello"], config, {
    spawn,
    contextWindow: "1m"
  }), 0);
  assert.deepEqual(args.slice(0, 4), ["-p", "hello", "--model", "sonnet[1m]"]);
  assert.equal(settings?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "anthropic/cannbot/glm-5.2[1m]");
  assert.equal(settings?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/cannbot/glm-5.2[1m]");
});

test("does not override a model explicitly supplied to Claude", async () => {
  let args: readonly string[] = [];
  const spawn = ((_command, receivedArgs) => {
    args = receivedArgs;
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: null, stdout: null, stderr: null, kill: () => true });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as SpawnFunction;

  const runClaudeCode = (processes as unknown as {
    runClaudeCode(
      args: readonly string[],
      config: ProjectConfig,
      options: { spawn: SpawnFunction; contextWindow: "1m" }
    ): Promise<number>;
  }).runClaudeCode;

  assert.equal(await runClaudeCode(["--model", "anthropic/cannbot/qwen3.7-max"], config, {
    spawn,
    contextWindow: "1m"
  }), 0);
  assert.deepEqual(args.slice(0, 2), ["--model", "anthropic/cannbot/qwen3.7-max"]);
  assert.equal(args.includes("sonnet[1m]"), false);

});
test("isolates Cannbot Claude state and API environment from native Claude", async () => {
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  let sessionRoot = "";
  let settingsPath = "";
  const parentEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "test-path",
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    HOME: "C:\\native-home",
    USERPROFILE: "C:\\native-profile",
    APPDATA: "C:\\native-appdata",
    LOCALAPPDATA: "C:\\native-localappdata",
    XDG_CONFIG_HOME: "C:\\native-xdg-config",
    XDG_DATA_HOME: "C:\\native-xdg-data",
    CLAUDE_CONFIG_DIR: "C:\\native-claude",
    ANTHROPIC_BASE_URL: "https://native.example",
    ANTHROPIC_API_KEY: "native-api-key",
    ANTHROPIC_AUTH_TOKEN: "native-auth-token",
    CODEX_HOME: "C:\\native-codex",
    HTTPS_PROXY: "http://proxy.example:8080",
    NO_PROXY: "internal.example",
    UNRELATED_SECRET: "must-not-leak"
  };
  const before = { ...parentEnv };
  const spawn = ((_command, receivedArgs, receivedOptions) => {
    spawnedEnv = receivedOptions.env;
    const settingsIndex = receivedArgs.lastIndexOf("--settings");
    settingsPath = receivedArgs[settingsIndex + 1];
    sessionRoot = dirname(settingsPath);
    const claudeConfig = spawnedEnv?.CLAUDE_CONFIG_DIR;
    assert.equal(typeof claudeConfig, "string");
    assert.equal(claudeConfig, join(sessionRoot, "claude"));
    mkdirSync(claudeConfig!, { recursive: true });
    writeFileSync(join(claudeConfig!, "model-state.json"), "private-model", "utf8");
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: null, stdout: null, stderr: null, kill: () => true });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as SpawnFunction;

  await processes.runClaudeCode([], config, { spawn, env: parentEnv });

  assert.deepEqual(parentEnv, before);
  assert.equal(spawnedEnv?.HOME, sessionRoot);
  assert.equal(spawnedEnv?.USERPROFILE, sessionRoot);
  assert.equal(spawnedEnv?.APPDATA, join(sessionRoot, "app-data"));
  assert.equal(spawnedEnv?.LOCALAPPDATA, join(sessionRoot, "app-data"));
  assert.equal(spawnedEnv?.XDG_CONFIG_HOME, join(sessionRoot, "xdg-config"));
  assert.equal(spawnedEnv?.XDG_DATA_HOME, join(sessionRoot, "xdg-data"));
  assert.equal(spawnedEnv?.CLAUDE_CONFIG_DIR, join(sessionRoot, "claude"));
  assert.equal(spawnedEnv?.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(spawnedEnv?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(spawnedEnv?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "");
  assert.equal(spawnedEnv?.ANTHROPIC_API_KEY, undefined);
  assert.equal(spawnedEnv?.ANTHROPIC_AUTH_TOKEN, "local-secret");
  assert.equal(spawnedEnv?.CODEX_HOME, undefined);
  assert.equal(spawnedEnv?.UNRELATED_SECRET, undefined);
  assert.equal(spawnedEnv?.PATH, parentEnv.PATH);
  assert.equal(spawnedEnv?.HTTPS_PROXY, parentEnv.HTTPS_PROXY);
  assert.match(spawnedEnv?.NO_PROXY ?? "", /internal\.example/);
  assert.equal(existsSync(settingsPath), false);
  assert.equal(existsSync(sessionRoot), false);
});

test("removes the private Claude root when spawning Claude fails", async () => {
  let sessionRoot = "";
  const spawn = ((_command, receivedArgs) => {
    sessionRoot = dirname(receivedArgs[receivedArgs.lastIndexOf("--settings") + 1]);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: null, stdout: null, stderr: null, kill: () => true });
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  }) as SpawnFunction;

  await assert.rejects(
    () => processes.runClaudeCode([], config, { spawn, env: { PATH: process.env.PATH } }),
    /spawn failed/
  );
  assert.equal(existsSync(sessionRoot), false);
});
