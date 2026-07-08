import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import * as processes from "../src/processes.js";
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
  let settings: { env: Record<string, string> } | undefined;
  const spawn = ((receivedCommand, receivedArgs, receivedOptions) => {
    command = receivedCommand;
    args = receivedArgs;
    options = receivedOptions;
    const settingsIndex = receivedArgs.lastIndexOf("--settings");
    settingsPath = receivedArgs[settingsIndex + 1];
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
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
  assert.equal(settings?.env.ANTHROPIC_AUTH_TOKEN, "local-secret");
  assert.equal(settings?.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(settings?.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "");
  assert.match(settings?.env.NO_PROXY ?? "", /internal\.example/);
  assert.match(settings?.env.NO_PROXY ?? "", /localhost/);
  assert.match(settings?.env.NO_PROXY ?? "", /127\.0\.0\.1/);
  assert.equal(existsSync(settingsPath), false);
  assert.equal(options?.env?.NODE_NO_WARNINGS, "1");
});
