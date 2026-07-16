import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createPrivateCcrEnvironment,
  type PrivateCcrPaths
} from "../src/private-ccr-environment.js";
import type { DetectedCcrVersion } from "../src/ccr-version.js";

interface PrivateCcrStoreLayout {
  readonly apiKeysDb: string;
  readonly configDb: string;
  readonly configDir: string;
  readonly gatewayConfigFile: string;
  readonly serviceStateFile: string;
}

interface SeedPrivateCcrStoreOptions {
  readonly corePort: number;
  readonly gatewayApiKey: string;
  readonly gatewayPort: number;
  readonly localSecret: string;
  readonly models: readonly string[];
  readonly paths: PrivateCcrPaths;
  readonly platform?: NodeJS.Platform;
  readonly shimPort: number;
  readonly version: DetectedCcrVersion;
}

interface PrivateCcrStoreModule {
  seedPrivateCcrStore(options: SeedPrivateCcrStoreOptions): Promise<PrivateCcrStoreLayout>;
}

async function loadPrivateCcrStore(): Promise<PrivateCcrStoreModule> {
  const modulePath = "../src/private-ccr-store.js";
  return await import(modulePath) as unknown as PrivateCcrStoreModule;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertInside(root: string, candidate: string): void {
  const resolved = relative(root, candidate);
  assert.notEqual(resolved, "");
  assert.ok(!isAbsolute(resolved));
  assert.ok(resolved !== "..");
  assert.ok(!resolved.startsWith(`..${sep}`));
}

function schemaSignature(database: DatabaseSync, table: string): string {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
    type: string;
  }>).map((column) => `${column.name}:${column.type.toUpperCase()}:${column.notnull}:${column.pk}`).join("|");
}

function readConfig(layout: PrivateCcrStoreLayout): Record<string, unknown> {
  const database = new DatabaseSync(layout.configDb);
  try {
    const row = database.prepare("SELECT value_json FROM app_config WHERE key = ?").get("default") as {
      value_json?: unknown;
    } | undefined;
    if (typeof row?.value_json !== "string") throw new Error("private CCR config is missing");
    return JSON.parse(row.value_json) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

function seedOptions(
  paths: PrivateCcrPaths,
  version: string
): SeedPrivateCcrStoreOptions {
  return {
    corePort: 43102,
    gatewayApiKey: "gateway-test-key",
    gatewayPort: 43101,
    localSecret: "shim-test-secret",
    models: ["glm-test"],
    paths,
    platform: "win32",
    shimPort: 43103,
    version: { major: 3, version }
  };
}

test("seeds a fully private CCR 3.0.6 layout for only the Cannbot provider", async () => {
  const session = await createPrivateCcrEnvironment({ parentEnv: { PATH: "private-path" } });
  try {
    const { seedPrivateCcrStore } = await loadPrivateCcrStore();
    const layout = await seedPrivateCcrStore(seedOptions(session.paths, "3.0.6"));

    assert.equal(layout.configDir, join(session.paths.appData, "claude-code-router"));
    assert.equal(layout.configDb, join(layout.configDir, "config.sqlite"));
    assert.equal(layout.apiKeysDb, join(session.paths.userData, "api-keys.sqlite"));
    assert.equal(layout.gatewayConfigFile, join(layout.configDir, "gateway.config.json"));
    assert.equal(layout.serviceStateFile, join(layout.configDir, "service.json"));
    for (const path of Object.values(layout)) assertInside(session.paths.root, path);
    assert.equal(await exists(layout.configDb), true);
    assert.equal(await exists(layout.apiKeysDb), true);
    assert.equal(await exists(`${layout.configDb}-wal`), false);
    assert.equal(await exists(`${layout.apiKeysDb}-wal`), false);

    const config = readConfig(layout);
    assert.equal(config.HOST, "127.0.0.1");
    assert.equal(config.PORT, 43102);
    assert.equal(config.routerEndpoint, "http://127.0.0.1:43101");
    assert.deepEqual(config.Providers, [{
      name: "cannbot",
      id: "cannbot",
      api_base_url: "http://127.0.0.1:43103/v1/chat/completions",
      api_key: "shim-test-secret",
      models: ["glm-test"],
      transformer: { use: ["openai"] }
    }]);
    assert.deepEqual(config.Router, {
      background: "cannbot,glm-test",
      builtInRules: {
        "claude-code": { enabled: false },
        codex: { enabled: false }
      },
      default: "cannbot,glm-test",
      fallback: { mode: "off", models: [], retryCount: 1 },
      longContext: "cannbot,glm-test",
      rules: [],
      think: "cannbot,glm-test"
    });
    assert.deepEqual(config.profile, {
      claudeCode: { enabled: false, model: "", settingsFile: "", smallFastModel: "" },
      codex: {
        cliMiddleware: false,
        codexCliPath: "",
        codexHome: "",
        configFile: "",
        configFormat: "separate_profile_files",
        enabled: false,
        model: "",
        providerId: "",
        providerName: "",
        showAllSessions: false
      },
      enabled: false,
      profiles: []
    });
    assert.deepEqual(config.gateway, {
      coreHost: "127.0.0.1",
      corePort: 43102,
      enabled: true,
      generatedConfigFile: layout.gatewayConfigFile,
      host: "127.0.0.1",
      port: 43101
    });
    assert.equal(config.autoStart, false);
    assert.equal(config.launchAtLogin, false);
    assert.deepEqual(config.agent, { mcpServers: [] });
    assert.deepEqual(config.botConfigs, []);
    assert.deepEqual(config.botGateway, {
      args: [],
      autoStartIntegration: false,
      command: "",
      createIntegration: false,
      credentials: {},
      enabled: false,
      integrationConfig: {},
      platform: "none"
    });
    assert.deepEqual(config.observability, { agentAnalysis: false, requestLogs: false });
    assert.deepEqual(config.proxy, {
      browserMode: false,
      captureNetwork: false,
      enabled: false,
      host: "127.0.0.1",
      mode: "gateway",
      port: 7890,
      systemProxy: false,
      targets: [],
      upstream: {
        custom: { password: "", port: 7890, server: "", username: "" },
        mode: "none"
      }
    });
    assert.deepEqual(config.toolHub, {
      browserAutomation: false,
      enabled: false,
      llm: { apiKey: "", baseUrl: "", model: "" },
      mcpServers: []
    });
    assert.deepEqual(config.APIKEYS, []);
    assert.equal(config.APIKEY, "");

    const configDb = new DatabaseSync(layout.configDb);
    const apiKeysDb = new DatabaseSync(layout.apiKeysDb);
    try {
      assert.equal(
        schemaSignature(configDb, "app_config"),
        "key:TEXT:0:1|value_json:TEXT:1:0|updated_at:TEXT:1:0"
      );
      assert.equal(
        schemaSignature(apiKeysDb, "api_keys"),
        "id:TEXT:0:1|name:TEXT:1:0|encrypted_key:TEXT:1:0|encryption:TEXT:1:0|created_at:TEXT:1:0|expires_at:TEXT:1:0|limits_json:TEXT:1:0"
      );
      const key = {
        ...(apiKeysDb.prepare(`
          SELECT id, name, encrypted_key, encryption FROM api_keys
        `).get() as Record<string, unknown>)
      };
      assert.deepEqual(key, {
        id: "cannbot-cc-private-gateway",
        name: "cannbot-cc private gateway",
        encrypted_key: "gateway-test-key",
        encryption: "plain"
      });
      assert.doesNotMatch(JSON.stringify(config), /gateway-test-key/);
    } finally {
      configDb.close();
      apiKeysDb.close();
    }
  } finally {
    await session.dispose();
  }
});

test("allows only the npm latest CCR CLI 3.0.6 to seed a private lifecycle store", async () => {
  const session = await createPrivateCcrEnvironment({ parentEnv: { PATH: "private-path" } });
  try {
    const { seedPrivateCcrStore } = await loadPrivateCcrStore();
    for (const patch of [...Array(15).keys()].filter((value) => value !== 6)) {
      await assert.rejects(
        () => seedPrivateCcrStore(seedOptions(session.paths, `3.0.${patch}`)),
        /private CCR lifecycle requires CCR 3\.0\.6/i
      );
    }
    assert.equal(await exists(join(session.paths.appData, "Claude Code Router", "config.sqlite")), false);
    assert.equal(await exists(join(session.paths.appData, "claude-code-router", "config.sqlite")), false);

    const layout = await seedPrivateCcrStore(seedOptions(session.paths, "3.0.6"));
    assert.equal(layout.configDir, join(session.paths.appData, "claude-code-router"));
    assert.equal(await exists(layout.configDb), true);
    assert.equal(await exists(layout.apiKeysDb), true);
  } finally {
    await session.dispose();
  }
});

test("rejects private layout requests that reuse a loopback port", async () => {
  const session = await createPrivateCcrEnvironment({ parentEnv: { PATH: "private-path" } });
  try {
    const { seedPrivateCcrStore } = await loadPrivateCcrStore();
    const options = { ...seedOptions(session.paths, "3.0.6"), corePort: 43101 };
    await assert.rejects(
      () => seedPrivateCcrStore(options),
      /ports.*distinct/i
    );
    assert.equal(await exists(join(session.paths.appData, "claude-code-router", "config.sqlite")), false);
  } finally {
    await session.dispose();
  }
});

test("rejects a gateway credential that equals the shim credential", async () => {
  const session = await createPrivateCcrEnvironment({ parentEnv: { PATH: "private-path" } });
  try {
    const { seedPrivateCcrStore } = await loadPrivateCcrStore();
    const options = { ...seedOptions(session.paths, "3.0.6"), gatewayApiKey: "shim-test-secret" };
    await assert.rejects(
      () => seedPrivateCcrStore(options),
      /gatewayApiKey.*differ/i
    );
    assert.equal(await exists(join(session.paths.appData, "claude-code-router", "config.sqlite")), false);
  } finally {
    await session.dispose();
  }
});
