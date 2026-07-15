import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { DetectedCcrVersion } from "./ccr-version.js";
import type { PrivateCcrPaths } from "./private-ccr-environment.js";

export interface PrivateCcrStoreLayout {
  readonly apiKeysDb: string;
  readonly configDb: string;
  readonly configDir: string;
  readonly gatewayConfigFile: string;
}

export interface ResolvePrivateCcrLayoutOptions {
  readonly paths: PrivateCcrPaths;
  readonly platform?: NodeJS.Platform;
  readonly version: DetectedCcrVersion;
}

export interface SeedPrivateCcrStoreOptions extends ResolvePrivateCcrLayoutOptions {
  readonly corePort: number;
  readonly gatewayApiKey: string;
  readonly gatewayPort: number;
  readonly localSecret: string;
  readonly models: readonly string[];
  readonly shimPort: number;
}

type SqliteDatabase = DatabaseSync;

const APP_CONFIG_SCHEMA = "key:TEXT:0:1|value_json:TEXT:1:0|updated_at:TEXT:1:0";
const API_KEYS_SCHEMA = "id:TEXT:0:1|name:TEXT:1:0|encrypted_key:TEXT:1:0|encryption:TEXT:1:0|created_at:TEXT:1:0|expires_at:TEXT:1:0|limits_json:TEXT:1:0";
const PRIVATE_GATEWAY_KEY_ID = "cannbot-cc-private-gateway";
const PRIVATE_GATEWAY_KEY_NAME = "cannbot-cc private gateway";

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

function supportedPrivatePatch(version: DetectedCcrVersion): number {
  const match = /^3\.0\.(0|[1-9]\d*)$/.exec(version.version);
  if (version.major !== 3 || !match) {
    throw new Error("Private CCR layout requires a supported CCR 3.0.x release");
  }
  const patch = Number(match[1]);
  if (patch > 13) {
    throw new Error("Private CCR layout supports CCR 3.0.0 through 3.0.13");
  }
  if (patch < 3) {
    throw new Error(`CCR ${version.version} cannot use a private layout because it has no public private lifecycle`);
  }
  return patch;
}

function assertInside(root: string, candidate: string): void {
  const resolved = relative(root, candidate);
  if (
    resolved.length === 0 ||
    isAbsolute(resolved) ||
    resolved === ".." ||
    resolved.startsWith(`..${sep}`)
  ) {
    throw new Error("Private CCR layout escaped its session root");
  }
}

function assertPrivateLayout(paths: PrivateCcrPaths, layout: PrivateCcrStoreLayout): void {
  for (const path of Object.values(layout)) assertInside(paths.root, path);
}

function validPort(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

function nonEmptySecret(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty`);
  return normalized;
}

function validModels(models: readonly string[]): string[] {
  const normalized = models.map((model) => model.trim());
  if (normalized.length === 0 || normalized.some((model) => model.length === 0) || new Set(normalized).size !== normalized.length) {
    throw new TypeError("Cannbot models must be unique non-empty strings");
  }
  return normalized;
}

function schemaSignature(database: SqliteDatabase, table: string): string {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[])
    .map((column) => `${column.name}:${column.type.toUpperCase()}:${column.notnull}:${column.pk}`)
    .join("|");
}

function validateSchema(database: SqliteDatabase, table: string, expected: string): void {
  if (schemaSignature(database, table) !== expected) {
    throw new Error(`Private CCR schema mismatch for ${table}`);
  }
}

function transaction(database: SqliteDatabase, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database failure.
    }
    throw error;
  }
}

async function openDatabase(path: string): Promise<SqliteDatabase> {
  let Database: typeof DatabaseSync;
  try {
    ({ DatabaseSync: Database } = await import("node:sqlite"));
  } catch {
    throw new Error("Private CCR requires a Node.js runtime with node:sqlite support");
  }
  return new Database(path);
}

function privateConfig(
  options: SeedPrivateCcrStoreOptions,
  layout: PrivateCcrStoreLayout,
  localSecret: string,
  models: readonly string[]
): Record<string, unknown> {
  const route = `cannbot,${models[0]}`;
  return {
    APIKEY: "",
    APIKEYS: [],
    API_TIMEOUT_MS: 600000,
    CUSTOM_ROUTER_PATH: "",
    HOST: "127.0.0.1",
    PORT: options.gatewayPort,
    Providers: [{
      name: "cannbot",
      api_base_url: `http://127.0.0.1:${options.shimPort}/v1/chat/completions`,
      api_key: localSecret,
      models: [...models],
      transformer: { use: ["openai"] }
    }],
    Router: {
      background: route,
      builtInRules: {
        "claude-code": { enabled: false },
        codex: { enabled: false }
      },
      default: route,
      fallback: { mode: "off", models: [], retryCount: 1 },
      longContext: route,
      rules: [],
      think: route
    },
    agent: { mcpServers: [] },
    autoStart: false,
    botConfigs: [],
    botGateway: {
      args: [],
      autoStartIntegration: false,
      command: "",
      createIntegration: false,
      credentials: {},
      enabled: false,
      integrationConfig: {},
      platform: "none"
    },
    gateway: {
      coreHost: "127.0.0.1",
      corePort: options.corePort,
      enabled: true,
      generatedConfigFile: layout.gatewayConfigFile,
      host: "127.0.0.1",
      port: options.gatewayPort
    },
    launchAtLogin: false,
    observability: { agentAnalysis: false, requestLogs: false },
    preferredProvider: "cannbot",
    plugins: [],
    profile: {
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
    },
    providerPlugins: [],
    proxy: {
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
    },
    routerEndpoint: `http://127.0.0.1:${options.gatewayPort}`,
    toolHub: {
      browserAutomation: false,
      enabled: false,
      llm: { apiKey: "", baseUrl: "", model: "" },
      mcpServers: []
    },
    virtualModelProfiles: []
  };
}

export function resolvePrivateCcrLayout(
  options: ResolvePrivateCcrLayoutOptions
): PrivateCcrStoreLayout {
  const patch = supportedPrivatePatch(options.version);
  const platform = options.platform ?? process.platform;
  const configDir = platform === "win32"
    ? join(options.paths.appData, patch === 3 ? "Claude Code Router" : "claude-code-router")
    : join(options.paths.home, ".claude-code-router");
  const layout: PrivateCcrStoreLayout = {
    apiKeysDb: join(options.paths.userData, "api-keys.sqlite"),
    configDb: join(configDir, "config.sqlite"),
    configDir,
    gatewayConfigFile: join(configDir, "gateway.config.json")
  };
  assertPrivateLayout(options.paths, layout);
  return layout;
}

export async function seedPrivateCcrStore(
  options: SeedPrivateCcrStoreOptions
): Promise<PrivateCcrStoreLayout> {
  const layout = resolvePrivateCcrLayout(options);
  const gatewayPort = validPort("gatewayPort", options.gatewayPort);
  const corePort = validPort("corePort", options.corePort);
  const shimPort = validPort("shimPort", options.shimPort);
  if (new Set([gatewayPort, corePort, shimPort]).size !== 3) {
    throw new TypeError("Private CCR gateway, core, and shim ports must be distinct");
  }
  const localSecret = nonEmptySecret("localSecret", options.localSecret);
  const gatewayApiKey = nonEmptySecret("gatewayApiKey", options.gatewayApiKey);
  if (localSecret === gatewayApiKey) {
    throw new TypeError("Private CCR gatewayApiKey must differ from localSecret");
  }
  const models = validModels(options.models);

  await Promise.all([
    mkdir(layout.configDir, { mode: 0o700, recursive: true }),
    mkdir(dirname(layout.apiKeysDb), { mode: 0o700, recursive: true })
  ]);
  const [configDb, apiKeysDb] = await Promise.all([
    openDatabase(layout.configDb),
    openDatabase(layout.apiKeysDb)
  ]);
  try {
    configDb.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    apiKeysDb.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        encrypted_key TEXT NOT NULL,
        encryption TEXT NOT NULL DEFAULT 'plain',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL DEFAULT '',
        limits_json TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS api_keys_created_at_idx ON api_keys(created_at);
    `);
    validateSchema(configDb, "app_config", APP_CONFIG_SCHEMA);
    validateSchema(apiKeysDb, "api_keys", API_KEYS_SCHEMA);
    const now = new Date().toISOString();
    transaction(configDb, () => {
      configDb.prepare(`
        INSERT INTO app_config (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run("default", JSON.stringify(privateConfig({ ...options, corePort, gatewayPort, shimPort }, layout, localSecret, models)), now);
    });
    transaction(apiKeysDb, () => {
      apiKeysDb.prepare(`
        INSERT INTO api_keys (id, name, encrypted_key, encryption, created_at, expires_at, limits_json)
        VALUES (?, ?, ?, 'plain', ?, '', '')
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          encrypted_key = excluded.encrypted_key,
          encryption = excluded.encryption,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          limits_json = excluded.limits_json
      `).run(PRIVATE_GATEWAY_KEY_ID, PRIVATE_GATEWAY_KEY_NAME, gatewayApiKey, now);
    });
    return layout;
  } finally {
    configDb.close();
    apiKeysDb.close();
  }
}
