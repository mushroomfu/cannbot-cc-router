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
  cannbotSession: string;
  openCodeAuthCandidates: string[];
}

export type ProxyMode = "auto" | "direct" | string;

export interface ProjectConfig {
  model: string;
  shimHost: "127.0.0.1";
  shimPort: number;
  localSecret: string;
  proxy: ProxyMode;
  ccrBackup?: string;
}
