import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  runAttached,
  runCaptured,
  type SpawnFunction
} from "../src/processes.js";

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

test("captured and attached execution preserve arguments and never invoke a shell", async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = fakeSpawn(calls, 7);

  const captured = await runCaptured("cannbot", ["models", "argument with spaces"], { spawn });
  const attached = await runAttached("claude", ["-p", "argument with spaces"], { spawn });

  assert.deepEqual(captured, { code: 7, stdout: "captured-out", stderr: "captured-error" });
  assert.equal(attached, 7);
  assert.deepEqual(calls[0].args, ["models", "argument with spaces"]);
  assert.deepEqual(calls[1].args, ["-p", "argument with spaces"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.stdio, "inherit");
});
