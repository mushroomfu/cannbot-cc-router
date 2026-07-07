import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  ccrStatus,
  checkExecutable,
  restartCcr,
  startCcr,
  stopCcr,
  type SpawnFunction
} from "../src/ccr-processes.js";

function spawnWith(
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>,
  code = 0,
  stdoutText = "Status: Running"
): SpawnFunction {
  return ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin: null, kill: () => true });
    queueMicrotask(() => {
      stdout.end(stdoutText);
      stderr.end();
      child.emit("close", code, null);
    });
    return child;
  }) as SpawnFunction;
}

test("checks executables and CCR status with bounded captured commands", async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = spawnWith(calls);

  assert.equal(await checkExecutable("cannbot", ["--version"], { spawn }), true);
  assert.equal(await ccrStatus({ spawn }), true);
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ["cannbot", ["--version"]],
    ["ccr", ["status"]]
  ]);
});

test("starts CCR detached and waits until status is ready", async () => {
  const launches: Array<{ command: string; args: readonly string[] }> = [];
  let checks = 0;

  await startCcr({
    spawnDetached: (command, args) => launches.push({ command, args }),
    status: async () => ++checks >= 2,
    sleep: async () => undefined
  });

  assert.deepEqual(launches, [{ command: "ccr", args: ["start"] }]);
});

test("does not launch CCR when it is already healthy", async () => {
  let launches = 0;
  await startCcr({
    spawnDetached: () => { launches += 1; },
    status: async () => true
  });
  assert.equal(launches, 0);
});

test("stops and restarts CCR through its public commands", async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = spawnWith(calls);

  assert.equal(await stopCcr({ spawn }), true);
  assert.equal(await restartCcr({ spawn, status: async () => true }), true);
  assert.deepEqual(calls.map((call) => call.args), [["stop"], ["restart"]]);
});
