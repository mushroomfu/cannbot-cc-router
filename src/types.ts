export interface CannbotCredentials {
  accessToken: string;
  virtualKey: string;
}

export interface ResolvedPaths {
  home: string;
  projectDir: string;
  projectConfig: string;
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
}
