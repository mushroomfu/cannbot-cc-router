import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { runCcrCode, type SpawnFunction } from "../src/processes.js";

test("suppresses CCR child-process deprecation noise only for code sessions", async () => {
  let received: SpawnOptions | undefined;
  const spawn = ((
    _command: string,
    _args: readonly string[],
    options: SpawnOptions
  ) => {
    received = options;
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: null, stdout: null, stderr: null, kill: () => true });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as SpawnFunction;

  assert.equal(await runCcrCode(["-p", "hello"], { spawn }), 0);
  assert.equal(received?.env?.NODE_NO_WARNINGS, "1");
});
