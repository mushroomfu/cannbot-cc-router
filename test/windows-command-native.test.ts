import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveCommand } from "../src/command-resolution.js";

test("executes a native binary referenced by an npm cmd shim directly", async () => {
  const bin = await mkdtemp(join(tmpdir(), "cannbot-command-native-"));
  const entry = join(bin, "node_modules", "example", "bin", "example.exe");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "binary fixture", "utf8");
  await writeFile(join(bin, "example.cmd"),
    '"%dp0%\\node_modules\\example\\bin\\example.exe" %*',
    "utf8"
  );

  assert.deepEqual(await resolveCommand("example", {
    platform: "win32",
    env: { PATH: bin }
  }), {
    command: entry,
    prefixArgs: []
  });
});
