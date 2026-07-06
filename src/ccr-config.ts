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
  setDefault: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    models: [options.model],
    transformer: { use: ["openai"] }
  });

  const router = structuredClone(input.Router);
  if (options.setDefault) {
    router.default = `cannbot,${options.model}`;
  }

  return {
    ...structuredClone(input),
    Providers: providers,
    Router: router
  } as CcrConfig;
}
