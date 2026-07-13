import { request } from "node:http";

import type { CcrAdapter, CcrConnection } from "./ccr-adapter.js";
import { reconcileCcrConfig, type ReconcileOptions } from "./ccr-config.js";
import type { CcrVersionRunner } from "./ccr-version.js";
import { runCaptured } from "./processes.js";
import {
  backupV3DatabasesOnce,
  discardV3Snapshot,
  openV3Store,
  restoreV3Databases,
  snapshotV3Databases,
  type V3Store
} from "./ccr-v3-store.js";
import type { ResolvedPaths } from "./types.js";

export interface CcrV3AdapterDependencies {
  health?: (baseUrl: string) => Promise<boolean>;
  paths: ResolvedPaths;
  run?: CcrVersionRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  store?: () => Promise<V3Store>;
  timeoutMs?: number;
}

function configuredPort(config: Record<string, unknown>): number {
  const gateway = config.gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) return 3456;
  const port = (gateway as Record<string, unknown>).port ?? 3456;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("CCR v3 gateway port must be an integer from 1 to 65535");
  }
  return port as number;
}

function directHealth(baseUrl: string): Promise<boolean> {
  const target = new URL("/health", baseUrl);
  return new Promise((resolve) => {
    const outgoing = request({ host: target.hostname, port: target.port, path: target.pathname, timeout: 1_000 }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    outgoing.once("timeout", () => outgoing.destroy());
    outgoing.once("error", () => resolve(false));
    outgoing.end();
  });
}

export class CcrV3Adapter implements CcrAdapter {
  readonly major = 3 as const;
  private readonly health: (baseUrl: string) => Promise<boolean>;
  private readonly run: CcrVersionRunner;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly store: () => Promise<V3Store>;
  private readonly timeoutMs: number;

  constructor(private readonly dependencies: CcrV3AdapterDependencies) {
    this.health = dependencies.health ?? directHealth;
    this.run = dependencies.run ?? runCaptured;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.store = dependencies.store ?? (() => openV3Store(dependencies.paths));
    this.timeoutMs = dependencies.timeoutMs ?? 15_000;
  }

  async loadConnection(): Promise<CcrConnection> {
    const store = await this.store();
    try {
      const [config, keys] = await Promise.all([store.readConfig(), store.readApiKeys()]);
      const apiKey = keys.find((key) => key.id === "cannbot-cc")?.key;
      if (!apiKey) throw new Error("CCR v3 Cannbot API key is missing; run `cannbot-cc sync`");
      return {
        major: this.major,
        baseUrl: `http://127.0.0.1:${configuredPort(config as Record<string, unknown>)}`,
        apiKey
      };
    } finally {
      await store.close();
    }
  }

  async reconcile(options: ReconcileOptions): Promise<void> {
    await backupV3DatabasesOnce(this.dependencies.paths);
    const snapshot = await snapshotV3Databases(this.dependencies.paths);
    try {
      const store = await this.store();
      try {
        await store.writeConfig(reconcileCcrConfig(await store.readConfig(), options));
        await store.upsertManagedApiKey(options.localSecret);
      } finally {
        await store.close();
      }
    } catch (error) {
      await restoreV3Databases(this.dependencies.paths, snapshot);
      throw error;
    } finally {
      await discardV3Snapshot(snapshot);
    }
  }

  async status(): Promise<boolean> {
    try {
      return await this.health((await this.loadBaseUrl()));
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (await this.status()) return;
    const result = await this.run("ccr", ["start"], { timeoutMs: this.timeoutMs });
    if (result.code !== 0 || !await this.waitForHealth(true)) {
      throw new Error("CCR v3 startup timed out");
    }
  }

  async stop(): Promise<boolean> {
    const result = await this.run("ccr", ["stop"], { timeoutMs: this.timeoutMs });
    return result.code === 0 && await this.waitForHealth(false);
  }

  async restart(): Promise<boolean> {
    if (!await this.stop()) return false;
    try {
      await this.start();
      return true;
    } catch {
      return false;
    }
  }

  private async loadBaseUrl(): Promise<string> {
    const store = await this.store();
    try {
      return `http://127.0.0.1:${configuredPort(await store.readConfig() as Record<string, unknown>)}`;
    } finally {
      await store.close();
    }
  }

  private async waitForHealth(expected: boolean): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (await this.status() === expected) return true;
      await this.sleep(200);
    }
    return false;
  }
}