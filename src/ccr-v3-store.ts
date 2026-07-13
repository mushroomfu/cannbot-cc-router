import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CcrConfig } from "./ccr-config.js";
import type { ResolvedPaths } from "./types.js";

export interface V3ApiKey {
  id: string;
  key: string;
  name: string;
}

export interface V3Store {
  close(): Promise<void>;
  readApiKeys(): Promise<V3ApiKey[]>;
  readConfig(): Promise<CcrConfig>;
  upsertApiKey(apiKey: V3ApiKey): Promise<void>;
  upsertManagedApiKey(key: string): Promise<void>;
  writeConfig(config: CcrConfig): Promise<void>;
}

async function openDatabase(path: string): Promise<DatabaseSync> {
  await mkdir(dirname(path), { recursive: true });
  let Database: typeof DatabaseSync;
  try {
    ({ DatabaseSync: Database } = await import("node:sqlite"));
  } catch {
    throw new Error("CCR v3 requires a Node.js runtime with node:sqlite support");
  }
  const database = new Database(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return database;
}

function ensureAppConfigSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function ensureApiKeySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      encryption TEXT NOT NULL DEFAULT 'plain',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT '',
      limits_json TEXT NOT NULL DEFAULT ''
    );
  `);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const APP_CONFIG_SCHEMA = "key:TEXT:0:1|value_json:TEXT:1:0|updated_at:TEXT:1:0";
const API_KEYS_SCHEMA = "id:TEXT:0:1|name:TEXT:1:0|encrypted_key:TEXT:1:0|encryption:TEXT:1:0|created_at:TEXT:1:0|expires_at:TEXT:1:0|limits_json:TEXT:1:0";

function schemaSignature(database: DatabaseSync, table: string): string {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
  return rows
    .map((column) => `${column.name}:${column.type.toUpperCase()}:${column.notnull}:${column.pk}`)
    .join("|");
}

function validateSchema(database: DatabaseSync, table: string, expected: string): void {
  const actual = schemaSignature(database, table);
  if (actual !== expected) throw new Error(`CCR v3 schema mismatch for ${table}`);
}

function transaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function backupV3DatabasesOnce(paths: ResolvedPaths): Promise<string | undefined> {
  const marker = join(paths.projectDir, "ccr-v3-backup.txt");
  if (await exists(marker)) {
    const previous = (await readFile(marker, "utf8")).trim();
    return previous || undefined;
  }
  const sources = [paths.ccrV3ConfigDb, paths.ccrV3ApiKeysDb];
  const present: string[] = [];
  for (const source of sources) {
    if (await exists(source)) present.push(source);
  }
  if (present.length === 0) return undefined;
  const backup = join(paths.projectDir, `ccr-v3-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backup, { recursive: true });
  for (const source of present) {
    const name = source === paths.ccrV3ConfigDb ? "config.sqlite" : "api-keys.sqlite";
    await copyFile(source, join(backup, name));
    for (const suffix of ["-wal", "-shm"]) {
      if (await exists(`${source}${suffix}`)) await copyFile(`${source}${suffix}`, join(backup, `${name}${suffix}`));
    }
  }
  await writeFile(marker, `${backup}\n`, { encoding: "utf8", mode: 0o600 });
  return backup;
}

function databaseEntries(paths: ResolvedPaths): Array<[string, string]> {
  return [
    [paths.ccrV3ConfigDb, "config.sqlite"],
    [paths.ccrV3ApiKeysDb, "api-keys.sqlite"]
  ];
}

async function copyDatabaseSet(paths: ResolvedPaths, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const [database, name] of databaseEntries(paths)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${database}${suffix}`;
      if (await exists(source)) await copyFile(source, join(destination, `${name}${suffix}`));
    }
  }
}

export async function snapshotV3Databases(paths: ResolvedPaths): Promise<string> {
  const snapshot = join(paths.projectDir, `ccr-v3-transaction-${randomUUID()}`);
  await copyDatabaseSet(paths, snapshot);
  return snapshot;
}

export async function restoreV3Databases(paths: ResolvedPaths, snapshot: string): Promise<void> {
  for (const [database, name] of databaseEntries(paths)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${database}${suffix}`;
      const source = join(snapshot, `${name}${suffix}`);
      await rm(target, { force: true });
      if (await exists(source)) await copyFile(source, target);
    }
  }
}

export async function discardV3Snapshot(snapshot: string): Promise<void> {
  await rm(snapshot, { force: true, recursive: true });
}
function emptyConfig(): CcrConfig {
  return { Providers: [], Router: {} };
}

function parseConfig(value: string | undefined): CcrConfig {
  if (!value) return emptyConfig();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CCR v3 app configuration must be an object");
  }
  const config = parsed as Partial<CcrConfig>;
  if (!Array.isArray(config.Providers) || !config.Router || typeof config.Router !== "object" || Array.isArray(config.Router)) {
    throw new Error("CCR v3 app configuration must contain Providers and Router");
  }
  return parsed as CcrConfig;
}

export async function openV3Store(paths: ResolvedPaths): Promise<V3Store> {
  const [configDb, apiKeysDb] = await Promise.all([
    openDatabase(paths.ccrV3ConfigDb),
    openDatabase(paths.ccrV3ApiKeysDb)
  ]);
  try {
    ensureAppConfigSchema(configDb);
    ensureApiKeySchema(apiKeysDb);
    validateSchema(configDb, "app_config", APP_CONFIG_SCHEMA);
    validateSchema(apiKeysDb, "api_keys", API_KEYS_SCHEMA);
  } catch (error) {
    configDb.close();
    apiKeysDb.close();
    throw error;
  }

  const upsertApiKey = async (apiKey: V3ApiKey): Promise<void> => {
    transaction(apiKeysDb, () => {
      apiKeysDb.prepare(`
        INSERT INTO api_keys (id, name, encrypted_key, encryption, created_at, expires_at, limits_json)
        VALUES (?, ?, ?, 'plain', ?, '', '')
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, encrypted_key = excluded.encrypted_key,
          encryption = excluded.encryption
      `).run(apiKey.id, apiKey.name, apiKey.key, new Date().toISOString());
    });
  };

  return {
    async close(): Promise<void> {
      configDb.close();
      apiKeysDb.close();
    },
    async readConfig(): Promise<CcrConfig> {
      const row = configDb.prepare("SELECT value_json FROM app_config WHERE key = ? LIMIT 1").get("default") as { value_json?: unknown } | undefined;
      return parseConfig(typeof row?.value_json === "string" ? row.value_json : undefined);
    },
    async writeConfig(config: CcrConfig): Promise<void> {
      transaction(configDb, () => {
        configDb.prepare(`
          INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `).run("default", JSON.stringify(config), new Date().toISOString());
      });
    },
    async readApiKeys(): Promise<V3ApiKey[]> {
      const rows = apiKeysDb.prepare(`
        SELECT id, name, encrypted_key FROM api_keys WHERE encryption = 'plain' ORDER BY rowid
      `).all() as Array<{ id: unknown; name: unknown; encrypted_key: unknown }>;
      return rows.filter((row): row is { id: string; name: string; encrypted_key: string } =>
        typeof row.id === "string" && typeof row.name === "string" && typeof row.encrypted_key === "string"
      ).map((row) => ({ id: row.id, name: row.name, key: row.encrypted_key }));
    },
    upsertApiKey,
    async upsertManagedApiKey(key: string): Promise<void> {
      await upsertApiKey({ id: "cannbot-cc", name: "cannbot-cc", key });
    }
  };
}