export interface CcrProvider {
  name: string;
  [key: string]: unknown;
}

export interface CcrConfig {
  Providers: CcrProvider[];
  Router: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReconcileOptions {
  shimPort: number;
  localSecret: string;
  model: string;
  models: readonly string[];
  setDefault: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateModels(models: readonly string[], selected: string): void {
  if (
    models.length === 0 ||
    models.some((model) => typeof model !== "string" || model.trim().length === 0) ||
    new Set(models).size !== models.length
  ) {
    throw new TypeError("Cannbot models must be unique non-empty strings");
  }
  if (!models.includes(selected)) {
    throw new TypeError("Cannbot models must contain the selected model");
  }
}

export function reconcileCcrConfig(
  input: unknown,
  options: ReconcileOptions
): CcrConfig {
  if (!isRecord(input)) {
    throw new TypeError("CCR configuration must be an object");
  }
  if (!Array.isArray(input.Providers)) {
    throw new TypeError("CCR configuration Providers must be an array");
  }
  if (!isRecord(input.Router)) {
    throw new TypeError("CCR configuration Router must be an object");
  }
  validateModels(options.models, options.model);

  const providers = input.Providers.map((provider) => {
    if (!isRecord(provider) || typeof provider.name !== "string") {
      throw new TypeError("Each CCR provider must be an object with a name");
    }
    return structuredClone(provider) as CcrProvider;
  }).filter((provider) => provider.name !== "cannbot");

  providers.push({
    name: "cannbot",
    api_base_url: `http://127.0.0.1:${options.shimPort}/v1/chat/completions`,
    api_key: options.localSecret,
    models: [...options.models],
    transformer: { use: ["openai"] }
  });

  const router = structuredClone(input.Router);
  if (options.setDefault) {
    const route = `cannbot,${options.model}`;
    for (const key of ["default", "think", "background", "longContext"] as const) {
      router[key] = route;
    }
  }

  return {
    ...structuredClone(input),
    Providers: providers,
    Router: router
  } as CcrConfig;
}

export function validateManagedCcrConfig(
  input: unknown,
  options: ReconcileOptions,
  requireRoutes: boolean
): void {
  validateModels(options.models, options.model);
  if (!isRecord(input)) throw new Error("CCR configuration must be an object");
  if (!Array.isArray(input.Providers)) throw new Error("CCR configuration Providers must be an array");
  if (!isRecord(input.Router)) throw new Error("CCR configuration Router must be an object");
  const providers = input.Providers
    .filter((provider): provider is Record<string, unknown> => isRecord(provider) && provider.name === "cannbot");
  if (providers.length !== 1) throw new Error("CCR managed cannbot provider is missing or duplicated");
  const provider = providers[0];
  const endpoint = `http://127.0.0.1:${options.shimPort}/v1/chat/completions`;
  if (
    typeof provider.api_key !== "string" || provider.api_key !== options.localSecret ||
    provider.api_base_url !== endpoint ||
    !Array.isArray(provider.models) ||
    JSON.stringify(provider.models) !== JSON.stringify(options.models)
  ) {
    throw new Error("CCR managed cannbot provider does not match the project configuration");
  }
  const transformer = provider.transformer;
  if (!isRecord(transformer)) throw new Error("CCR managed cannbot transformer is invalid");
  const uses = transformer.use;
  if (!Array.isArray(uses) || uses.length !== 1 || uses[0] !== "openai") {
    throw new Error("CCR managed cannbot transformer is invalid");
  }
  if (requireRoutes) {
    const route = `cannbot,${options.model}`;
    for (const key of ["default", "think", "background", "longContext"] as const) {
      if (input.Router[key] !== route) throw new Error(`CCR managed route ${key} is missing or invalid`);
    }
  }
}
