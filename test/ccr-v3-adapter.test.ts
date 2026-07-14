import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CcrV3Adapter } from "../src/ccr-v3-adapter.js";
import { resolvePaths } from "../src/paths.js";
import { openV3Store } from "../src/ccr-v3-store.js";

import type { ProjectConfig } from "../src/types.js";
const options = {
  shimPort: 8787,
  localSecret: "local-secret",
  model: "glm-5.2",
  models: ["glm-5.2"],
  setDefault: true
};

const project: ProjectConfig = {
  model: "glm-5.2",
  models: ["glm-5.2"],
  shimHost: "127.0.0.1",
  shimPort: 8787,
  localSecret: "local-secret",
  proxy: "auto",
  managedRoutes: true
};

async function preparedAdapter(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const paths = resolvePaths({ home, platform: "linux" });
  const adapter = new CcrV3Adapter({
    paths,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => false
  });
  await adapter.reconcile(options);
  return { adapter, paths };
}

test("v3 connection prefers the generated runtime gateway port", async () => {
  const { adapter, paths } = await preparedAdapter("cannbot-ccr-v3-runtime-");
  await writeFile(paths.ccrV3GatewayConfig, JSON.stringify({ port: 4567 }), "utf8");
  assert.equal((await adapter.loadConnection()).baseUrl, "http://127.0.0.1:4567");
});

test("v3 connection supports persisted CCR port forms before first start", async () => {
  for (const [field, value, expected] of [
    ["gateway", { port: 4568 }, 4568],
    ["PORT", 4569, 4569],
    ["routerEndpoint", "http://localhost:4570", 4570]
  ] as const) {
    const { adapter, paths } = await preparedAdapter(`cannbot-ccr-v3-${field}-`);
    const store = await openV3Store(paths);
    const config = await store.readConfig();
    await store.writeConfig({ ...config, [field]: value });
    await store.close();
    assert.equal((await adapter.loadConnection()).baseUrl, `http://127.0.0.1:${expected}`);
  }
});

test("v3 connection rejects malformed runtime gateway configuration", async () => {
  const { adapter, paths } = await preparedAdapter("cannbot-ccr-v3-bad-runtime-");
  await writeFile(paths.ccrV3GatewayConfig, "{broken", "utf8");
  await assert.rejects(() => adapter.loadConnection(), /runtime gateway configuration is invalid/);
});

test("v3 connection rejects invalid persisted gateway ports", async () => {
  const { adapter, paths } = await preparedAdapter("cannbot-ccr-v3-bad-port-");
  const store = await openV3Store(paths);
  const config = await store.readConfig();
  await store.writeConfig({ ...config, PORT: 0 });
  await store.close();
  await assert.rejects(() => adapter.loadConnection(), /integer from 1 to 65535/);
});

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
    baseUrl: "http://127.0.0.1:3457",
    apiKey: "local-secret"
  });
  await adapter.validateManagedState(project);
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
test("v3 managed-state validation rejects a missing provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-invalid-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const store = await openV3Store(paths);
  await store.writeConfig({ Providers: [], Router: {
    default: "cannbot,glm-5.2",
    think: "cannbot,glm-5.2",
    background: "cannbot,glm-5.2",
    longContext: "cannbot,glm-5.2"
  } });
  await store.upsertManagedApiKey("local-secret");
  await store.close();
  const adapter = new CcrV3Adapter({
    paths,
    health: async () => false
  });
  await assert.rejects(() => adapter.validateManagedState(project), /provider/i);
});

test("v3 managed-state validation rejects missing routes and keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-state-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const store = await openV3Store(paths);
  const provider = {
    name: "cannbot",
    api_base_url: "http://127.0.0.1:8787/v1/chat/completions",
    api_key: "local-secret",
    models: ["glm-5.2"],
    transformer: { use: ["openai"] }
  };
  await store.writeConfig({ Providers: [provider], Router: {} });
  await store.upsertManagedApiKey("local-secret");
  await store.close();
  const adapter = new CcrV3Adapter({
    paths,
    health: async () => false
  });
  await assert.rejects(() => adapter.validateManagedState(project), /route/i);
  const repaired = await openV3Store(paths);
  await repaired.writeConfig({ Providers: [provider], Router: {
    default: "cannbot,glm-5.2",
    think: "cannbot,glm-5.2",
    background: "cannbot,glm-5.2",
    longContext: "cannbot,glm-5.2"
  } });
  await repaired.close();
  const apiKeysDb = new DatabaseSync(paths.ccrV3ApiKeysDb);
  apiKeysDb.prepare("DELETE FROM api_keys WHERE id = ?").run("cannbot-cc");
  apiKeysDb.close();
  await assert.rejects(() => adapter.validateManagedState(project), /API key/i);
});
