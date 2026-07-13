import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { writeJsonAtomic } from "../src/file-store.js";
import {
  ensureShim,
  runAttached,
  runCaptured,
  runCcrCode,
  stopShim,
  type SpawnFunction
} from "../src/processes.js";
import { createShim } from "../src/shim.js";
import type { ProjectConfig, ResolvedPaths } from "../src/types.js";

function fakeSpawn(
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>,
  exitCode = 0
): SpawnFunction {
  return ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin: null, pid: 1234, kill: () => true });
    queueMicrotask(() => {
      stdout.end("captured-out");
      stderr.end("captured-error");
      child.emit("close", exitCode, null);
    });
    return child;
  }) as SpawnFunction;
}

const config: ProjectConfig = {
  model: "glm-5.2",
  models: ["glm-5.2"],
  shimHost: "127.0.0.1",
  shimPort: 8787,
  localSecret: "local-secret",
  proxy: "auto"
};

function paths(root: string): ResolvedPaths {
  return {
    home: root,
    projectDir: root,
    projectConfig: join(root, "config.json"),
    shimState: join(root, "shim-state.json"),
    ccrConfig: join(root, "ccr.json"),
    ccrV2Config: join(root, "ccr.json"),
    ccrV3ConfigDb: join(root, "config.sqlite"),
    ccrV3ApiKeysDb: join(root, "api-keys.sqlite"),
    openCodeAuthCandidates: [join(root, "auth.json")]
  };
}

test("captured and attached execution never invokes a shell", async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = fakeSpawn(calls, 7);

  const captured = await runCaptured("ccr", ["status", "argument with spaces"], { spawn });
  const attached = await runAttached("ccr", ["code", "argument with spaces"], { spawn });

  assert.deepEqual(captured, { code: 7, stdout: "captured-out", stderr: "captured-error" });
  assert.equal(attached, 7);
  assert.deepEqual(calls[0].args, ["status", "argument with spaces"]);
  assert.deepEqual(calls[1].args, ["code", "argument with spaces"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.stdio, "inherit");
});

test("CCR code preserves all Claude arguments", async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const code = await runCcrCode(["-p", "hello world", "--allowedTools", "Read"], {
    spawn: fakeSpawn(calls)
  });

  assert.equal(code, 0);
  assert.deepEqual(calls[0].args, ["code", "-p", "hello world", "--allowedTools", "Read"]);
});

test("ensureShim launches Node detached and accepts only matching health", async () => {
  const root = await mkdtemp(join(tmpdir(), "cannbot-processes-"));
  const launches: Array<{ command: string; args: string[] }> = [];
  let healthCalls = 0;

  const result = await ensureShim(config, paths(root), {
    shimEntry: "C:/project/dist/src/shim-main.js",
    spawnDetached: (command, args) => launches.push({ command, args }),
    health: async () => {
      healthCalls += 1;
      return healthCalls < 2
        ? undefined
        : { status: "ok", instanceId: "matching", pid: 1234 };
    },
    sleep: async () => undefined,
    expectedInstanceId: async () => "matching"
  });

  assert.equal(result.instanceId, "matching");
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, process.execPath);
  assert.deepEqual(launches[0].args, ["C:/project/dist/src/shim-main.js", "--config", paths(root).projectConfig]);
});

test("stopShim uses authenticated HTTP shutdown instead of killing a PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "cannbot-processes-stop-"));
  const resolved = paths(root);
  const shim = createShim({
    localSecret: config.localSecret,
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    proxyMode: "direct",
    readCredentials: async () => ({ virtualKey: "key" }),
    refreshCredentials: async () => undefined
  });
  const address = await shim.listen();
  await writeJsonAtomic(resolved.shimState, {
    pid: process.pid,
    port: address.port,
    instanceId: shim.instanceId
  });

  assert.equal(await stopShim({ ...config, shimPort: address.port }, resolved), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: address.port, path: "/health" }, resolve)
      .once("error", reject)
      .end();
  }), /ECONNREFUSED|socket hang up/);
});
