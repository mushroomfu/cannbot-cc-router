import assert from "node:assert/strict";
import test from "node:test";

import { redact } from "../src/redact.js";

test("redacts known values and authentication headers", () => {
  const input = [
    "Authorization: Bearer access-secret",
    "x-api-vkey=virtual-secret",
    "plain access-secret virtual-secret"
  ].join(" ");

  assert.equal(
    redact(input, ["access-secret", "virtual-secret"]),
    "Authorization: Bearer [REDACTED] x-api-vkey=[REDACTED] plain [REDACTED] [REDACTED]"
  );
});

test("redacts sensitive JSON fields without known values", () => {
  const input = JSON.stringify({
    accessToken: "one",
    refreshToken: "two",
    apiKey: "three",
    key: "not-redacted-without-sensitive-context",
    model: "glm-5.2"
  });

  const output = redact(input);
  assert.doesNotMatch(output, /one|two|three/);
  assert.match(output, /glm-5\.2/);
});

test("ignores empty known-secret values", () => {
  assert.equal(redact("ordinary output", ["", "   "]), "ordinary output");
});
