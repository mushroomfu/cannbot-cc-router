import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CcrV3Adapter } from "../src/ccr-v3-adapter.js";
import { resolvePaths } from "../src/paths.js";

const options = {
  shimPort: 8787,
  localSecret: "local-secret",
  model: "glm-5.2",
  models: ["glm-5.2"],
  setDefault: true
};

test("v3 adapter reconciles SQLite and exposes the managed loopback key", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-adapter-"));
  const adapter = new CcrV3Adapter({
    paths: resolvePaths({ home, platform: "linux" }),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => true
  });
  await adapter.reconcile(options);

  assert.deepEqual(await adapter.loadConnection(), {
    major: 3,
    baseUrl: "http://127.0.0.1:3456",
    apiKey: "local-secret"
  });
});

test("v3 restart uses stop then start and health checks", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-restart-"));
  const calls: string[] = [];
  let healthy = true;
  const adapter = new CcrV3Adapter({
    paths: resolvePaths({ home, platform: "linux" }),
    run: async (_command, args) => {
      calls.push(args.join(" "));
      healthy = args[0] === "start";
      return { code: 0, stdout: "", stderr: "" };
    },
    health: async () => healthy,
    sleep: async () => undefined
  });

  assert.equal(await adapter.restart(), true);
  assert.deepEqual(calls, ["stop", "start"]);
});