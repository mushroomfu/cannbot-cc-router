import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CcrV3Adapter } from "../src/ccr-v3-adapter.js";
import { resolvePaths } from "../src/paths.js";
import { openV3Store } from "../src/ccr-v3-store.js";

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
    health: async () => false
  });
  await adapter.reconcile(options);
  await adapter.reconcile(options);

  assert.deepEqual(await adapter.loadConnection(), {
    major: 3,
    baseUrl: "http://127.0.0.1:3456",
    apiKey: "local-secret"
  });
});

test("v3 adapter refuses to reconcile while the gateway is healthy", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-running-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const store = await openV3Store(paths);
  await store.writeConfig({ Providers: [{ name: "other", models: ["old"] }], Router: {} });
  await store.close();
  const adapter = new CcrV3Adapter({
    paths,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => true
  });

  await assert.rejects(() => adapter.reconcile(options), /stop CCR/i);
  const unchanged = await openV3Store(paths);
  assert.deepEqual(
    (await unchanged.readConfig()).Providers.map((provider) => provider.name),
    ["other"]
  );
  await unchanged.close();
});

test("v3 status polls a real loopback health endpoint", async (t) => {
  const server = createServer((request, response) => {
    response.statusCode = request.url === "/health" ? 200 : 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-health-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const store = await openV3Store(paths);
  await store.writeConfig({
    gateway: { port: address.port },
    Providers: [],
    Router: {}
  });
  await store.upsertManagedApiKey("local-secret");
  await store.close();
  const calls: string[] = [];
  const adapter = new CcrV3Adapter({ paths, run: async (_command, args) => {
    calls.push(args.join(" "));
    return { code: 0, stdout: "", stderr: "" };
  } });
  assert.equal(await adapter.status(), true);

  await adapter.start();
  assert.deepEqual(calls, []);
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