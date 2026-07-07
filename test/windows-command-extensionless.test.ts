import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveCommand } from "../src/command-resolution.js";

test("resolves an extensionless Node entry from an npm cmd shim", async () => {
  const bin = await mkdtemp(join(tmpdir(), "cannbot-command-extensionless-"));
  const entry = join(bin, "node_modules", "example", "bin", "example");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(bin, "example.cmd"),
    '"%_prog%" "%dp0%\\node_modules\\example\\bin\\example" %*',
    "utf8"
  );

  assert.deepEqual(await resolveCommand("example", {
    platform: "win32",
    env: { PATH: bin }
  }), {
    command: process.execPath,
    prefixArgs: [entry]
  });
});
