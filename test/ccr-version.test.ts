import assert from "node:assert/strict";
import test from "node:test";

import { detectCcrVersion, parseCcrVersion } from "../src/ccr-version.js";

test("parses supported CCR v2 and v3 version output", () => {
  assert.equal(parseCcrVersion("claude-code-router version: 2.0.0"), 2);
  assert.equal(parseCcrVersion("claude-code-router version: 3.0.10"), 3);
});

test("rejects unsupported and malformed CCR versions", () => {
  assert.throws(() => parseCcrVersion("claude-code-router version: 4.0.0"), /supported versions are 2 and 3/i);
  assert.throws(() => parseCcrVersion("no version"), /unable to determine/i);
});

test("detects the CCR major version from its command output", async () => {
  assert.equal(await detectCcrVersion(async () => ({
    code: 0,
    stdout: "claude-code-router version: 3.0.10\n",
    stderr: ""
  })), 3);
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