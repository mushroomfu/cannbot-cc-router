import type { ReconcileOptions } from "./ccr-config.js";
import type { CcrMajorVersion } from "./ccr-version.js";

export interface CcrConnection {
  major: CcrMajorVersion;
  baseUrl: string;
  apiKey?: string;
}

export interface CcrAdapter {
  readonly major: CcrMajorVersion;
  loadConnection(): Promise<CcrConnection>;
  reconcile(options: ReconcileOptions): Promise<void>;
  status(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<boolean>;
  restart(): Promise<boolean>;
}