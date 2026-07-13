import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";


import { CcrV3Adapter } from "../src/ccr-v3-adapter.js";
import { backupV3DatabasesOnce, openV3Store } from "../src/ccr-v3-store.js";
import { resolvePaths } from "../src/paths.js";

test("v3 store preserves unrelated providers and API keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-"));
  const store = await openV3Store(resolvePaths({ home, platform: "linux" }));
  await store.writeConfig({ Providers: [{ name: "other", models: [] }], Router: {} });
  await store.upsertApiKey({ id: "other-key", key: "other-secret", name: "other" });

  await store.writeConfig({
    Providers: [{ name: "other", models: [] }, { name: "cannbot", models: ["glm-5.2"] }],
    Router: { default: "cannbot,glm-5.2" }
  });
  await store.upsertManagedApiKey("local-secret");

  assert.deepEqual((await store.readConfig()).Providers.map((provider) => provider.name), ["other", "cannbot"]);
  assert.deepEqual((await store.readApiKeys()).map(({ id, key }) => ({ id, key })), [
    { id: "other-key", key: "other-secret" },
    { id: "cannbot-cc", key: "local-secret" }
  ]);
  await store.close();
});

test("v3 store replaces its managed API key without duplicating it", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-key-"));
  const store = await openV3Store(resolvePaths({ home, platform: "linux" }));
  await store.upsertManagedApiKey("old-secret");
  await store.upsertManagedApiKey("new-secret");
  assert.deepEqual(await store.readApiKeys(), [{
    id: "cannbot-cc", key: "new-secret", name: "cannbot-cc"
  }]);
  await store.close();
});
test("backs up existing v3 configuration and API-key databases once", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-backup-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const store = await openV3Store(paths);
  await store.writeConfig({ Providers: [], Router: {} });
  await store.upsertManagedApiKey("local-secret");
  await store.close();

  const backup = await backupV3DatabasesOnce(paths);
  assert.ok(backup);
  await stat(join(backup!, "config.sqlite"));
  await stat(join(backup!, "api-keys.sqlite"));
  assert.equal(await backupV3DatabasesOnce(paths), backup);
});
test("rejects a malformed v3 schema before writing either database", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-schema-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await mkdir(dirname(paths.ccrV3ApiKeysDb), { recursive: true });
  const configDb = new DatabaseSync(paths.ccrV3ConfigDb);
  configDb.exec(`
    CREATE TABLE app_config (key TEXT PRIMARY KEY);
  `);
  configDb.close();
  const apiKeysDb = new DatabaseSync(paths.ccrV3ApiKeysDb);
  apiKeysDb.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      encryption TEXT NOT NULL DEFAULT 'plain',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT '',
      limits_json TEXT NOT NULL DEFAULT ''
    );
  `);
  apiKeysDb.close();
  await assert.rejects(() => openV3Store(paths), /schema.*app_config/i);
});

test("restores both v3 databases when the API-key write fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v3-restore-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const store = await openV3Store(paths);
  await store.writeConfig({ Providers: [{ name: "other", models: ["old"] }], Router: { default: "other,old" } });
  await store.upsertApiKey({ id: "other-key", key: "other-secret", name: "other" });
  await store.close();
  const apiKeysDb = new DatabaseSync(paths.ccrV3ApiKeysDb);
  apiKeysDb.exec(`
    CREATE TRIGGER reject_cannbot_key
    BEFORE INSERT ON api_keys
    WHEN NEW.id = 'cannbot-cc'
    BEGIN
      SELECT RAISE(ABORT, 'forced API-key failure');
    END;
  `);
  apiKeysDb.close();
  const adapter = new CcrV3Adapter({
    paths,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => false
  });
  await assert.rejects(() => adapter.reconcile({
    shimPort: 8787,
    localSecret: "local-secret",
    model: "glm-5.2",
    models: ["glm-5.2"],
    setDefault: true
  }), /forced API-key failure/);
  const restored = await openV3Store(paths);
  assert.deepEqual((await restored.readConfig()).Providers.map((provider) => provider.name), ["other"]);
  assert.deepEqual(await restored.readApiKeys(), [
    { id: "other-key", key: "other-secret", name: "other" }
  ]);
  await restored.close();
});
