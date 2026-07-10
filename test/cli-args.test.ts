import assert from "node:assert/strict";
import test from "node:test";

import { buildProgram, type CommandHandlers } from "../src/cli.js";

test("code command preserves unknown Claude options and argument boundaries", async () => {
  let received: string[] = [];
  const zero = async () => 0;
  const handlers: CommandHandlers = {
    init: zero,
    sync: zero,
    start: zero,
    restart: zero,
    stop: zero,
    status: zero,
    doctor: zero,
    code: async (args) => { received = args; return 0; }
  };

  await buildProgram(handlers).exitOverride().parseAsync([
    "code", "-p", "hello world", "--allowedTools", "Read", "--output-format", "text"
  ], { from: "user" });

  assert.deepEqual(received, [
    "-p", "hello world", "--allowedTools", "Read", "--output-format", "text"
  ]);
});

test("code command consumes its context option before forwarding Claude arguments", async () => {
  let receivedArgs: string[] = [];
  let receivedOptions: unknown;
  const zero = async () => 0;
  const handlers: CommandHandlers = {
    init: zero,
    sync: zero,
    start: zero,
    restart: zero,
    stop: zero,
    status: zero,
    doctor: zero,
    code: async (args, options) => {
      receivedArgs = args;
      receivedOptions = options;
      return 0;
    }
  };

  await buildProgram(handlers).exitOverride().parseAsync([
    "code", "--context", "1m", "-p", "hello world"
  ], { from: "user" });

  assert.deepEqual(receivedArgs, ["-p", "hello world"]);
  assert.deepEqual(receivedOptions, { context: "1m" });
});
