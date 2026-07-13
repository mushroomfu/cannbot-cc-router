import {
  reconcileCcrConfig,
  validateManagedCcrConfig,
  type ReconcileOptions
} from "./ccr-config.js";
import { ccrStatus, restartCcr, startCcr, stopCcr } from "./ccr-processes.js";
import { readJsonFile, writeJsonAtomic } from "./file-store.js";
import type { CcrAdapter, CcrConnection } from "./ccr-adapter.js";
import type { ProjectConfig, ResolvedPaths } from "./types.js";

function readConnection(value: unknown): Omit<CcrConnection, "major"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CCR v2 configuration must be an object");
  }
  const config = value as Record<string, unknown>;
  const port = config.PORT ?? 3456;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("CCR v2 port must be an integer from 1 to 65535");
  }
  if (config.APIKEY !== undefined && typeof config.APIKEY !== "string") {
    throw new Error("CCR v2 APIKEY must be a string");
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    ...(typeof config.APIKEY === "string" ? { apiKey: config.APIKEY } : {})
  };
}

export class CcrV2Adapter implements CcrAdapter {
  readonly major = 2 as const;

  constructor(private readonly paths: ResolvedPaths) {}

  async loadConnection(): Promise<CcrConnection> {
    return { major: this.major, ...readConnection(await readJsonFile(this.paths.ccrV2Config)) };
  }

  async reconcile(options: ReconcileOptions): Promise<void> {
    const input = await readJsonFile<unknown>(this.paths.ccrV2Config);
    await writeJsonAtomic(this.paths.ccrV2Config, reconcileCcrConfig(input, options));
  }

  async validateManagedState(project: ProjectConfig): Promise<void> {
    validateManagedCcrConfig(await readJsonFile(this.paths.ccrV2Config), {
      shimPort: project.shimPort,
      localSecret: project.localSecret,
      model: project.model,
      models: project.models,
      setDefault: false
    }, project.managedRoutes === true);
  }

  status(): Promise<boolean> { return ccrStatus(); }
  async start(): Promise<void> { await startCcr(); }
  stop(): Promise<boolean> { return stopCcr(); }
  restart(): Promise<boolean> { return restartCcr(); }
}