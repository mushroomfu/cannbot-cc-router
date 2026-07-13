import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveCommand } from "../src/command-resolution.js";

test("resolves a Windows npm cmd shim to its Node JavaScript entry", async () => {
  const bin = await mkdtemp(join(tmpdir(), "cannbot-command-"));
  const entry = join(bin, "node_modules", "example", "dist", "cli.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "console.log('ok')", "utf8");
  await writeFile(join(bin, "example.cmd"), [
    "@ECHO off",
    "SET dp0=%~dp0",
    '"%_prog%" "%dp0%\\node_modules\\example\\dist\\cli.js" %*'
  ].join("\r\n"), "utf8");

  assert.deepEqual(await resolveCommand("example", {
    platform: "win32",
    env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }
  }), {
    command: process.execPath,
    prefixArgs: [entry],
    entry
  });
});

test("leaves POSIX and unresolved commands unchanged", async () => {
  assert.deepEqual(await resolveCommand("ccr", {
    platform: "linux",
    env: { PATH: "/usr/bin" }
  }), { command: "ccr", prefixArgs: [] });
  assert.deepEqual(await resolveCommand("missing", {
    platform: "win32",
    env: { PATH: "C:/empty", PATHEXT: ".EXE;.CMD" }
  }), { command: "missing", prefixArgs: [] });
});
