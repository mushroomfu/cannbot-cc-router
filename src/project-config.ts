import { readJsonFile, writeJsonAtomic } from "./file-store.js";
import type { ProjectConfig, ResolvedPaths } from "./types.js";

export interface ProjectConfigBootstrapDependencies {
  listModels(): Promise<string[]>;
  secret(): string;
}

function validateProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object") throw new Error("Project config must be an object");
  const config = value as Partial<ProjectConfig>;
  if (
    typeof config.model !== "string" || !config.model.trim() ||
    typeof config.shimPort !== "number" ||
    typeof config.localSecret !== "string" ||
    typeof config.proxy !== "string"
  ) throw new Error("Project config is incomplete");
  const models = config.models ?? [config.model];
  if (
    !Array.isArray(models) || models.length === 0 ||
    models.some((model) => typeof model !== "string" || !model.trim())
  ) throw new Error("Project config model catalog is invalid");
  return { ...config, models: [...models], shimHost: "127.0.0.1" } as ProjectConfig;
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function loadOrCreateProjectConfig(
  paths: ResolvedPaths,
  dependencies: ProjectConfigBootstrapDependencies
): Promise<ProjectConfig> {
  try {
    return validateProjectConfig(await readJsonFile(paths.projectConfig));
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const models = await dependencies.listModels();
  if (models.length === 0 || models.some((model) => typeof model !== "string" || !model.trim())) {
    throw new Error("Unable to query Cannbot models");
  }
  const localSecret = dependencies.secret();
  if (!localSecret) throw new Error("Unable to create project session seed");
  const model = models.includes("glm-5.2") ? "glm-5.2" : models[0];
  const config: ProjectConfig = {
    localSecret,
    model,
    models: [...models],
    proxy: "auto",
    shimHost: "127.0.0.1",
    shimPort: 0
  };
  await writeJsonAtomic(paths.projectConfig, config);
  return config;
}
