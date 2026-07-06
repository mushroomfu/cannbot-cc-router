import assert from "node:assert/strict";
import test from "node:test";

import { buildProgram } from "../src/cli.js";

test("help exposes the complete command surface", () => {
  const names = buildProgram().commands.map((command) => command.name());
  assert.deepEqual(names, [
    "init",
    "sync",
    "start",
    "restart",
    "stop",
    "status",
    "code",
    "doctor"
  ]);
});
