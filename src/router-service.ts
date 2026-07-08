import type { ProjectConfig } from "./types.js";

export interface InitOptions {
  model: string;
  proxy: string;
  shimPort: number;
  setDefault: boolean;
}

export interface SyncOptions {
  setDefault: boolean;
}

export interface RouterStatus {
  shim: boolean;
  ccr: boolean;
}

export interface RouterServiceDependencies {
  initialize(options: InitOptions): Promise<ProjectConfig>;
  loadConfig(): Promise<ProjectConfig>;
  validateCredentials(): Promise<void>;
  reconcile(config: ProjectConfig, setDefault: boolean): Promise<void>;
  ensureShim(config: ProjectConfig): Promise<void>;
  startCcr(): Promise<void>;
  stopShim(config: ProjectConfig): Promise<boolean>;
  stopCcr(): Promise<boolean>;
  restartCcr(): Promise<boolean>;
  shimStatus(config: ProjectConfig): Promise<boolean>;
  ccrStatus(): Promise<boolean>;
  runClaudeCode(args: readonly string[], config: ProjectConfig): Promise<number>;
}

export class RouterService {
  constructor(private readonly dependencies: RouterServiceDependencies) {}

  async init(options: InitOptions): Promise<ProjectConfig> {
    return this.dependencies.initialize(options);
  }

  async sync(options: SyncOptions = { setDefault: false }): Promise<ProjectConfig> {
    const config = await this.dependencies.loadConfig();
    await this.dependencies.validateCredentials();
    await this.dependencies.reconcile(config, options.setDefault);
    return config;
  }

  async start(options: SyncOptions = { setDefault: false }): Promise<void> {
    const config = await this.sync(options);
    await this.dependencies.ensureShim(config);
    await this.dependencies.startCcr();
  }

  async restart(options: SyncOptions = { setDefault: false }): Promise<void> {
    const config = await this.sync(options);
    await this.dependencies.stopShim(config);
    await this.dependencies.ensureShim(config);
    if (!await this.dependencies.restartCcr()) {
      throw new Error("CCR restart failed");
    }
  }

  async stop(): Promise<RouterStatus> {
    const config = await this.dependencies.loadConfig();
    const shim = await this.dependencies.stopShim(config);
    const ccr = await this.dependencies.stopCcr();
    return { shim, ccr };
  }

  async status(): Promise<RouterStatus> {
    const config = await this.dependencies.loadConfig();
    const shim = await this.dependencies.shimStatus(config);
    const ccr = await this.dependencies.ccrStatus();
    return { shim, ccr };
  }

  async code(args: readonly string[]): Promise<number> {
    await this.start();
    const config = await this.dependencies.loadConfig();
    return this.dependencies.runClaudeCode(args, config);
  }
}
