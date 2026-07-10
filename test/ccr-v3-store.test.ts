import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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