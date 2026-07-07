import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveCommand } from "../src/command-resolution.js";

test("skips npm wrapper node.exe probe and resolves the later package entry", async () => {
  const bin = await mkdtemp(join(tmpdir(), "cannbot-command-multiple-"));
  const entry = join(bin, "node_modules", "cannbot", "bin", "cannbot");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(bin, "cannbot.cmd"), [
    '@ECHO off',
    'IF EXIST "%dp0%\\node.exe" SET "_prog=%dp0%\\node.exe"',
    '"%_prog%" "%dp0%\\node_modules\\cannbot\\bin\\cannbot" %*'
  ].join("\r\n"), "utf8");

  assert.deepEqual(await resolveCommand("cannbot", {
    platform: "win32",
    env: { PATH: bin }
  }), {
    command: process.execPath,
    prefixArgs: [entry]
  });
});
