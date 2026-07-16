import assert from "node:assert/strict";
import test from "node:test";

import { parseSupportedCcrVersion } from "../src/ccr-version.js";

test("accepts canonical CCR npm CLI versions 3.0.0 through 3.0.6", () => {
  for (let patch = 0; patch <= 6; patch += 1) {
    const version = `3.0.${patch}`;
    assert.deepEqual(parseSupportedCcrVersion(version), { major: 3, version });
  }
});

test("rejects unavailable, newer, legacy, and non-canonical identifiers", () => {
  for (const version of [
    "2.0.0",
    "3.0.7",
    "3.0.14",
    "3.1.0",
    "4.0.0",
    "3.0.6-beta.1",
    "3.0.6+build.1",
    "03.0.6",
    "3.00.6",
    "3.0.006",
    "3.0"
  ]) {
    assert.throws(() => parseSupportedCcrVersion(version), /supported|unable/i);
  }
});
