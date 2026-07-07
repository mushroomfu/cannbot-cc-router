import assert from "node:assert/strict";
import test from "node:test";

import {
  parseShimMainArgs,
  refreshCannbotCredentials
} from "../src/shim-main.js";

test("requires an explicit project configuration path", () => {
  assert.equal(
    parseShimMainArgs(["node", "shim-main.js", "--config", "C:/home/config.json"]),
    "C:/home/config.json"
  );
  assert.throws(() => parseShimMainArgs(["node", "shim-main.js"]), /--config/);
});

test("refreshes through a bounded Cannbot model query", async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs?: number }> = [];
  await refreshCannbotCredentials(async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return { code: 0, stdout: "cannbot/glm-5.2", stderr: "" };
  });

  assert.deepEqual(calls, [{
    command: "cannbot",
    args: ["models", "cannbot"],
    timeoutMs: 30_000
  }]);
});

test("reports Cannbot refresh failure without command output", async () => {
  await assert.rejects(
    refreshCannbotCredentials(async () => ({
      code: 1,
      stdout: "access-secret",
      stderr: "private-error"
    })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Cannbot credential validation failed");
      return true;
    }
  );
});
