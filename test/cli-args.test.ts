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
