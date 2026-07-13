import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  detectCcrVersion,
  parseCcrVersion,
  parseSupportedCcrVersion
} from "../src/ccr-version.js";

test("parses supported CCR v2 and v3 version output", () => {
  assert.equal(parseCcrVersion("claude-code-router version: 2.0.0"), 2);
  assert.equal(parseCcrVersion("claude-code-router version: 3.0.10"), 3);
});

test("rejects unsupported and malformed CCR versions", () => {
  assert.throws(() => parseCcrVersion("claude-code-router version: 4.0.0"), /supported/i);
  assert.throws(() => parseCcrVersion("no version"), /unable to determine/i);
});

test("detects the CCR major version from its command output", async () => {
  assert.deepEqual(await detectCcrVersion(async () => ({
    code: 0,
    stdout: "claude-code-router version: 3.0.10\n",
    stderr: ""
  })), { major: 3, version: "3.0.10" });
});

test("reports a failed CCR version command without its output", async () => {
  await assert.rejects(
    () => detectCcrVersion(async () => ({
      code: 1,
      stdout: "sensitive details",
      stderr: "more sensitive details"
    })),
    /Unable to determine CCR version/
  );
});
test("detects CCR 3.0.0 from its installed package when the CLI has no version command", async () => {
  const root = await mkdtemp(join(tmpdir(), "cannbot-ccr-version-"));
  const entry = join(root, "node_modules", "@musistudio", "claude-code-router", "dist", "main", "cli.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(root, "node_modules", "@musistudio", "claude-code-router", "package.json"), JSON.stringify({
    name: "@musistudio/claude-code-router",
    version: "3.0.0"
  }), "utf8");

  assert.deepEqual(await detectCcrVersion({
    resolve: async () => ({ command: process.execPath, prefixArgs: [entry], entry }),
    run: async () => ({ code: 1, stdout: "", stderr: "" })
  }), { major: 3, version: "3.0.0" });
});

test("accepts only supported CCR generations", () => {
  assert.deepEqual(parseSupportedCcrVersion("2.0.0"), { major: 2, version: "2.0.0" });
  assert.deepEqual(parseSupportedCcrVersion("3.0.3"), { major: 3, version: "3.0.3" });
  assert.throws(() => parseSupportedCcrVersion("1.0.73"), /supported/i);
  assert.throws(() => parseSupportedCcrVersion("3.1.0"), /supported.*3\.0\.x/i);
  assert.throws(() => parseSupportedCcrVersion("4.0.0"), /supported/i);
  assert.throws(() => parseSupportedCcrVersion("3.0"), /unable to determine/i);
});

test("rejects package metadata owned by a different package", async () => {
  const root = await mkdtemp(join(tmpdir(), "cannbot-ccr-owner-"));
  const entry = join(root, "node_modules", "not-ccr", "dist", "cli.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(root, "node_modules", "not-ccr", "package.json"), JSON.stringify({
    name: "not-ccr",
    version: "3.0.0"
  }), "utf8");

  await assert.rejects(() => detectCcrVersion({
    resolve: async () => ({ command: process.execPath, prefixArgs: [entry], entry }),
    run: async () => ({ code: 1, stdout: "", stderr: "" })
  }), /unable to determine/i);
});
