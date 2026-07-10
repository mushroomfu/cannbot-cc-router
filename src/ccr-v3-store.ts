import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  ensureAppConfigSchema(configDb);
  ensureApiKeySchema(apiKeysDb);

  const upsertApiKey = async (apiKey: V3ApiKey): Promise<void> => {
    apiKeysDb.prepare(`
      INSERT INTO api_keys (id, name, encrypted_key, encryption, created_at, expires_at, limits_json)
      VALUES (?, ?, ?, 'plain', ?, '', '')
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, encrypted_key = excluded.encrypted_key,
        encryption = excluded.encryption
    `).run(apiKey.id, apiKey.name, apiKey.key, new Date().toISOString());
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
      configDb.prepare(`
        INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run("default", JSON.stringify(config), new Date().toISOString());
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