export interface CannbotCredentials {
  accessToken: string;
  virtualKey: string;
}

export interface ResolvedPaths {
  home: string;
  projectDir: string;
  projectConfig: string;
  shimState: string;
  ccrConfig: string;
  ccrV2Config: string;
  ccrV3ConfigDb: string;
  ccrV3ApiKeysDb: string;
  cannbotSession: string;
  openCodeAuthCandidates: string[];
}

export type ProxyMode = "auto" | "direct" | string;

export interface ProjectConfig {
  model: string;
  models: string[];
  shimHost: "127.0.0.1";
  shimPort: number;
  localSecret: string;
  proxy: ProxyMode;
  managedRoutes?: boolean;
  ccrBackup?: string;
}