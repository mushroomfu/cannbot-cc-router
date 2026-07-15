import assert from "node:assert/strict";
import test from "node:test";

import { buildProgram } from "../src/cli.js";

test("help exposes only the Claude-only code and doctor commands", () => {
  const program = buildProgram();
  assert.deepEqual(program.commands.map((command) => command.name()), ["code", "doctor"]);

  const help = program.helpInformation();
  for (const forbidden of ["init", "sync", "start", "restart", "stop", "status", "--set-default"]) {
    assert.doesNotMatch(help, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
