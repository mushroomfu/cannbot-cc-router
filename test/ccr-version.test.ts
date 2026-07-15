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

test("parses only CCR 3.0.0 through 3.0.13", () => {
  for (let patch = 0; patch <= 13; patch += 1) {
    const version = `3.0.${patch}`;
    assert.deepEqual(parseSupportedCcrVersion(version), { major: 3, version });
  }

  assert.equal(parseCcrVersion("claude-code-router version: 3.0.10"), 3);

  for (const unsupported of [
    "2.0.0",
    "2.9.9",
    "3.0.14",
    "3.1.0",
    "4.0.0",
    "3.0.13-beta.1",
    "3.0.13+build.1",
    "3.0"
  ]) {
    assert.throws(() => parseSupportedCcrVersion(unsupported), /supported|unable/i);
  }
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

test("rejects non-canonical CCR version identifiers", () => {
  for (const version of ["03.0.13", "3.00.13", "3.0.013"]) {
    assert.throws(() => parseSupportedCcrVersion(version), /supported|unable/i);
  }
});

test("version fallback runs the resolved private artifact with its child environment", async () => {
  const env: NodeJS.ProcessEnv = { PATH: "private-path" };
  const detected = await detectCcrVersion({
    env,
    resolve: async () => ({ command: "private-ccr", prefixArgs: ["private-entry"] }),
    run: async (command, args, options) => {
      assert.equal(command, "private-ccr");
      assert.deepEqual(args, ["private-entry", "version"]);
      assert.equal(options.env, env);
      assert.equal(options.timeoutMs, 10_000);
      return {
        code: 0,
        stdout: "claude-code-router version: 3.0.13",
        stderr: ""
      };
    }
  });

  assert.deepEqual(detected, { major: 3, version: "3.0.13" });
});
