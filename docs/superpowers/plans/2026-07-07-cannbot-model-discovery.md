# Cannbot Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code discover and select every current Cannbot model while routing default, think, background, and long-context traffic through Cannbot without changing global Claude settings.

**Architecture:** The loopback shim becomes a path-routed gateway: it serves `/v1/models`, forwards Anthropic endpoints to CCR, and keeps forwarding `/v1/chat/completions` to Cannbot. `cannbot-cc code` launches Claude directly with a temporary settings file that points at the shim and enables gateway discovery.

**Tech Stack:** Node.js 20+, TypeScript 6, native `node:http`, native `node:test`, Commander, CCR 2.x.

## Global Constraints

- Bind all local services to `127.0.0.1`; never expose the shim on a non-loopback interface.
- Never persist or log Cannbot access tokens or virtual keys.
- Preserve every unrelated CCR provider, Router field, and top-level setting.
- Keep shell execution disabled and preserve Windows, macOS, and Linux command resolution.
- Proxy only outbound Cannbot traffic; loopback Claude/shim/CCR traffic must bypass Shadowsocks.
- Do not modify `~/.claude/settings.json` or any other global Claude settings file.
- Query model IDs from `cannbot models cannbot`; do not hard-code the five currently observed IDs.
- Use test-driven development: each production change follows a test that was observed failing for the intended reason.

---

## File Structure

- `src/types.ts`: persist the non-secret discovered model catalog in `ProjectConfig`.
- `src/default-service.ts`: normalize and refresh Cannbot models, migrate legacy project config, and pass the catalog into CCR reconciliation.
- `src/ccr-config.ts`: manage the full Cannbot provider catalog and four Cannbot route categories.
- `src/shim.ts`: route model discovery, Claude-to-CCR requests, and CCR-to-Cannbot requests.
- `src/shim-main.ts`: load CCR loopback connection details and provide them to the shim.
- `src/processes.ts`: launch Claude with a temporary settings file.
- `src/router-service.ts`: invoke the direct Claude launcher after starting managed services.
- `README.md`: document model discovery, route ownership, and Shadowsocks behavior.
- Existing and new files under `test/`: prove every behavior without real credentials or network access.

---

### Task 1: Persist the complete model catalog and reconcile all Cannbot routes

**Files:**
- Modify: `src/types.ts`
- Modify: `src/default-service.ts`
- Modify: `src/ccr-config.ts`
- Modify: `test/default-service.test.ts`
- Modify: `test/ccr-config.test.ts`

**Interfaces:**
- Produces: `ProjectConfig.models: string[]`.
- Produces: `ReconcileOptions.models: readonly string[]`.
- Produces: `parseCannbotModels(output: string): string[]`, returning ordered, unique, prefix-stripped IDs.
- Produces: `listCannbotModels(runner?: CapturedRunner): Promise<string[]>`, allowing a fake runner in tests.
- Consumes: the existing `cannbot models cannbot` CLI output and selected `ProjectConfig.model`.

- [ ] **Step 1: Write failing parser and initialization tests**

Extend `test/default-service.test.ts` with assertions equivalent to:

```ts
test("normalizes and de-duplicates Cannbot models in reported order", () => {
  assert.deepEqual(parseCannbotModels([
    "anthropic/cannbot/glm-5.2",
    "anthropic/cannbot/deepseek-v4-pro",
    "anthropic/cannbot/glm-5.2",
    "noise"
  ].join("\n")), ["glm-5.2", "deepseek-v4-pro"]);
});
```

In the initialization test, assert:

```ts
assert.deepEqual(config.models, ["deepseek-v4-pro", "glm-5.2"]);
const cannbot = (storedCcr.Providers as Array<Record<string, unknown>>)
  .find((provider) => provider.name === "cannbot");
assert.deepEqual(cannbot?.models, ["deepseek-v4-pro", "glm-5.2"]);
for (const route of ["default", "think", "background", "longContext"]) {
  assert.equal(
    (storedCcr.Router as Record<string, string>)[route],
    "cannbot,glm-5.2"
  );
}
```

Add a test that an empty parsed catalog makes `listCannbotModels` fail with `Unable to query Cannbot models`, and a legacy project JSON without `models` loads as `models: [model]`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm run build
node --test dist/test/default-service.test.js dist/test/ccr-config.test.js
```

Expected: FAIL because `ProjectConfig.models` and `ReconcileOptions.models` do not exist, the provider contains one model, and only `Router.default` changes.

- [ ] **Step 3: Implement catalog persistence and route reconciliation**

Change `ProjectConfig` in `src/types.ts` to include:

```ts
export interface ProjectConfig {
  model: string;
  models: string[];
  shimHost: "127.0.0.1";
  shimPort: number;
  localSecret: string;
  proxy: ProxyMode;
  ccrBackup?: string;
}
```

In `src/default-service.ts`:

1. Rework `parseCannbotModels` with a `Set<string>` so blank, unrelated, and duplicate lines are removed while order is preserved.
2. Define a local `CapturedRunner` interface matching `runCaptured`, accept it as an optional `listCannbotModels` argument, and reject both a non-zero command and an empty normalized catalog.
3. Make `validateProjectConfig` accept legacy data and return `models: config.models ?? [config.model]` after validating every supplied model is a non-empty string.
4. During `initializeProject`, assign the full queried catalog to `config.models`.
5. During `reconcileProject`, query a fresh catalog before any write, verify it contains `config.model`, create `nextConfig = { ...config, models }`, build the CCR result, then write `nextConfig` and the CCR result.
6. Pass `models: config.models` to every `reconcileCcrConfig` call, including Doctor validation.

Change `ReconcileOptions` in `src/ccr-config.ts` to:

```ts
export interface ReconcileOptions {
  shimPort: number;
  localSecret: string;
  model: string;
  models: readonly string[];
  setDefault: boolean;
}
```

Validate that `models` is non-empty, contains unique non-empty strings, and contains `model`. Write `models: [...options.models]` into the managed provider. When `setDefault` is true, set exactly these four keys to the same route string:

```ts
const route = `cannbot,${options.model}`;
for (const key of ["default", "think", "background", "longContext"] as const) {
  router[key] = route;
}
```

Do not alter unrelated Router keys when `setDefault` is false.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="Cannbot|reconcil|initializ|legacy" dist/test/*.test.js
npm run check
```

Expected: all tests pass; no credentials appear in serialized project or CCR fixtures.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/types.ts src/default-service.ts src/ccr-config.ts test/default-service.test.ts test/ccr-config.test.ts
git commit -m "feat: synchronize Cannbot model catalog"
```

---

### Task 2: Add model discovery and Anthropic-to-CCR paths to the shim

**Files:**
- Modify: `src/shim.ts`
- Modify: `src/shim-main.ts`
- Create: `test/shim-model-discovery.test.ts`
- Create: `test/shim-ccr-proxy.test.ts`
- Modify: `test/shim-main.test.ts`

**Interfaces:**
- Consumes: `ShimOptions.models: readonly string[]`, `ShimOptions.ccrUrl: string`, and optional `ShimOptions.ccrApiKey?: string`.
- Produces: authenticated `GET /v1/models?limit=1000`.
- Produces: authenticated passthrough for `POST /v1/messages` and `POST /v1/messages/count_tokens`.
- Produces: `loadShimOptions(configPath: string): Promise<ShimOptions>` for startup wiring and isolated tests.
- Preserves: existing `POST /v1/chat/completions`, health, shutdown, retry, proxy, and size-limit behavior.

- [ ] **Step 1: Write a failing authenticated model-discovery test**

Create `test/shim-model-discovery.test.ts` using a real loopback shim and native HTTP request. Assert that `GET /v1/models?limit=1000` with `Authorization: Bearer local-secret` returns status 200 and:

```ts
{
  object: "list",
  data: [
    { id: "anthropic/cannbot/deepseek-v4-pro", display_name: "Cannbot · deepseek-v4-pro", object: "model", owned_by: "cannbot" },
    { id: "anthropic/cannbot/glm-5.2", display_name: "Cannbot · glm-5.2", object: "model", owned_by: "cannbot" }
  ]
}
```

Assert the same request without the local bearer token returns 401 and contains no model IDs.

- [ ] **Step 2: Run the discovery test and verify RED**

Run:

```powershell
npm run build
node --test dist/test/shim-model-discovery.test.js
```

Expected: FAIL because `ShimOptions.models` and `GET /v1/models?limit=1000` are not implemented.

- [ ] **Step 3: Implement only `/v1/models` and verify GREEN**

Add these required fields to `ShimOptions`:

```ts
models: readonly string[];
ccrUrl: string;
ccrApiKey?: string;
```

After `/health` and before `/shutdown`, authenticate the request and return a freshly allocated model list:

```ts
if (incoming.method === "GET" && incoming.url === "/v1/models") {
  if (!secretsEqual(incoming.headers.authorization, options.localSecret)) {
    response.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    object: "list",
    data: options.models.map((id) => ({ id: `anthropic/cannbot/${id}`, display_name: `Cannbot · ${id}`, object: "model", owned_by: "cannbot" }))
  }));
  return;
}
```

Update every shim test fixture to supply `models`, `ccrUrl`, and `ccrApiKey`.

Run the focused test again. Expected: PASS.

- [ ] **Step 4: Write failing CCR JSON and SSE passthrough tests**

Create `test/shim-ccr-proxy.test.ts` with a fake loopback CCR server. Test both paths:

```ts
const cases = ["/v1/messages", "/v1/messages/count_tokens"];
```

For each path, send the local bearer token to the shim and assert the fake CCR receives:

- the exact path and every original POST field, with only `model: "anthropic/cannbot/glm-5.2"` rewritten to `model: "cannbot,glm-5.2"`;
- `x-api-key: ccr-local-key`;
- neither the shim bearer token nor any Cannbot access token;
- the original content type.

Have the fake CCR return JSON for `count_tokens` and chunked `text/event-stream` for `messages`; assert the shim preserves status, content type, and complete body. Add a connection-refused case asserting sanitized status 502 and body `{"error":"upstream_failure"}`.

- [ ] **Step 5: Run the CCR proxy tests and verify RED**

Run:

```powershell
npm run build
node --test dist/test/shim-ccr-proxy.test.js
```

Expected: FAIL with 404 because the Anthropic paths are not routed.

- [ ] **Step 6: Implement the CCR proxy path and verify GREEN**

Extract header copying into a helper that removes hop-by-hop, host, authorization, `x-api-key`, and content-length headers. For CCR-bound requests, set:

```ts
headers["x-api-key"] = options.ccrApiKey ?? "test";
headers["content-length"] = String(body.byteLength);
```

Add `rewriteClaudeModel(body, models)`: parse the JSON object, rewrite a known `cannbot/<id>` value to `cannbot,<id>`, reject an unknown `cannbot/` value with a sanitized 400 error, and serialize the object without changing other fields. Add a `makeCcrRequest` helper that resolves `incoming.url` against `options.ccrUrl`, always uses direct loopback `httpRequest`, and never calls `selectProxy` or `createProxyAgent`. Route only the two exact Anthropic paths to this helper, using the rewritten body, existing body limit, and `copyResponse`. Do not apply the Cannbot credential refresh logic to CCR responses.

Keep `/v1/chat/completions` on the existing Cannbot helper. This exact-path split is the loop-prevention boundary.

Run:

```powershell
node --test dist/test/shim-model-discovery.test.js dist/test/shim-ccr-proxy.test.js dist/test/shim.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js
```

Expected: all shim tests pass.

- [ ] **Step 7: Wire CCR settings into `shim-main`**

Extend `test/shim-main.test.ts` so exported `loadShimOptions` reads a temporary project and CCR config with `PORT: 3456` and `APIKEY: "ccr-local-key"`, producing options equivalent to:

```ts
{
  models: ["deepseek-v4-pro", "glm-5.2"],
  ccrUrl: "http://127.0.0.1:3456",
  ccrApiKey: "ccr-local-key"
}
```

Extract `loadShimOptions(configPath)` from `runShimMain`. It reads `paths.ccrConfig`, validates `PORT` as an integer from 1 through 65535, accepts `APIKEY` only when it is a string, and returns all options required by `createShim`. If `PORT` is absent, use 3456. Make `runShimMain` call `createShim(await loadShimOptions(configPath))`. Do not print `APIKEY`.

- [ ] **Step 8: Run all tests and commit Task 2**

```powershell
npm run check
git add src/shim.ts src/shim-main.ts test/shim-model-discovery.test.ts test/shim-ccr-proxy.test.ts test/shim-main.test.ts test/shim*.test.ts
git commit -m "feat: expose Cannbot models through the shim"
```

Expected: the full suite passes.

---

### Task 3: Launch Claude directly with temporary gateway-discovery settings

**Files:**
- Modify: `src/processes.ts`
- Modify: `src/router-service.ts`
- Modify: `src/default-service.ts`
- Modify: `test/processes-warning.test.ts`
- Create: `test/processes-claude.test.ts`
- Modify: `test/commands.test.ts`

**Interfaces:**
- Produces: `runClaudeCode(args: readonly string[], config: ProjectConfig, options?: RunOptions): Promise<number>`.
- Changes: `RouterServiceDependencies.runCcrCode` to `runClaudeCode(args, config)`.
- Consumes: the existing cross-platform `resolveCommandSync` through `runAttached`/`defaultSpawn`.

- [ ] **Step 1: Write failing temporary-settings launcher tests**

Create `test/processes-claude.test.ts` with an injected `SpawnFunction` that captures command, arguments, and spawn options and emits `close`. Have the fake spawn read and parse the settings path synchronously before it emits `close`. Assert:

```ts
assert.equal(command, "claude");
assert.deepEqual(receivedUserArgs, ["-p", "hello world", "--allowedTools", "Read"]);
assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "local-secret");
assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
assert.match(settings.env.NO_PROXY, /127\.0\.0\.1/);
assert.match(settings.env.NO_PROXY, /localhost/);
```

Assert the generated `--settings` argument occurs after the unchanged user arguments so project-owned gateway settings take precedence. After `runClaudeCode` resolves, assert the temporary directory no longer exists. Assert `shell: false` and `stdio: "inherit"`.

Update `test/commands.test.ts` so `code()` expects `runClaudeCode(args, config)` after `start()`.

- [ ] **Step 2: Run the launcher tests and verify RED**

Run:

```powershell
npm run build
node --test dist/test/processes-claude.test.js dist/test/commands.test.js
```

Expected: FAIL because `runClaudeCode` and the new dependency do not exist.

- [ ] **Step 3: Implement the direct Claude launcher**

In `src/processes.ts`, add native imports for `mkdtemp`, `writeFile`, `rm`, `tmpdir`, and `join`. Implement an internal loopback `NO_PROXY` merge that preserves existing comma-separated entries and appends missing `localhost` and `127.0.0.1`.

Implement `runClaudeCode` so it:

1. Creates a `cannbot-cc-` temporary directory.
2. Writes mode-0600 `settings.json` containing:

```ts
const settings = {
  env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.shimPort}`,
    ANTHROPIC_AUTH_TOKEN: config.localSecret,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    NO_PROXY: mergeNoProxy(options.env?.NO_PROXY ?? process.env.NO_PROXY),
    DISABLE_TELEMETRY: "true",
    DISABLE_COST_WARNINGS: "true",
    API_TIMEOUT_MS: "600000"
  }
};
```

3. Calls `runAttached("claude", [...args, "--settings", settingsPath], { ...options, env: { ...process.env, ...options.env, NODE_NO_WARNINGS: "1" } })`.
4. Removes the temporary directory in `finally`, including spawn failure and non-zero exit.

Never put Cannbot credentials in this file; `localSecret` is the shim-only bearer token.

In `src/router-service.ts`, change the dependency to:

```ts
runClaudeCode(args: readonly string[], config: ProjectConfig): Promise<number>;
```

Then implement:

```ts
async code(args: readonly string[]): Promise<number> {
  await this.start();
  const config = await this.dependencies.loadConfig();
  return this.dependencies.runClaudeCode(args, config);
}
```

In `src/default-service.ts`, inject `runClaudeCode` instead of `runCcrCode`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```powershell
npm run build
node --test dist/test/processes-claude.test.js dist/test/commands.test.js dist/test/windows-command*.test.js
```

Expected: all tests pass; captured spawn options show `shell: false`; Windows wrapper resolution tests remain green.

- [ ] **Step 5: Update warning regression and commit Task 3**

Replace the obsolete CCR-specific warning test with a test that `NODE_NO_WARNINGS=1` is scoped to the Claude child process. Then run and commit:

```powershell
npm run check
git add src/processes.ts src/router-service.ts src/default-service.ts test/processes-claude.test.ts test/processes-warning.test.ts test/commands.test.ts
git commit -m "feat: launch Claude with model discovery"
```

Expected: full suite passes.

---

### Task 4: Document and verify the complete model-discovery workflow

**Files:**
- Modify: `README.md`
- Modify: `test/doctor.test.ts` or `test/default-service.test.ts` only if verification exposes a missing automated assertion.

**Interfaces:**
- Consumes: completed Tasks 1閳?.
- Produces: user-facing local test instructions and fresh end-to-end evidence.

- [ ] **Step 1: Update README behavior and commands**

Replace the statement that `code` runs `ccr code`. Document that it starts CCR and the shim, then launches Claude with temporary gateway settings. Add:

```markdown
Inside Claude Code, run `/model`. The list is populated from the current
output of `cannbot models cannbot`; selecting a model does not edit
`~/.claude/settings.json`.

To refresh the catalog and route all CCR categories through the selected
default model:

    cannbot-cc sync --set-default
    cannbot-cc restart --set-default
    cannbot-cc code
```

State that Shadowsocks may remain enabled because only the Cannbot outbound hop uses it and loopback hops are forced into `NO_PROXY`.

- [ ] **Step 2: Run clean automated verification**

```powershell
npm run check
npm pack --dry-run
git diff --check
```

Expected: all tests pass, package contents include only distributable files, and `git diff --check` reports nothing.

- [ ] **Step 3: Run local live configuration and discovery verification**

Build, synchronize, and restart:

```powershell
npm run build
node dist\src\cli.js sync --set-default
node dist\src\cli.js restart --set-default
node dist\src\cli.js status --json
```

Expected status: `{"shim":true,"ccr":true}`.

Read the project config and send authenticated `GET http://127.0.0.1:8787/v1/models` without printing the token. Compare returned IDs to `cannbot models cannbot`; strip the `cannbot/` and `anthropic/cannbot/` prefixes respectively; the underlying model sets and order must match.

Inspect sanitized CCR configuration and assert:

- managed provider `cannbot.models` equals the discovered list;
- `default`, `think`, `background`, and `longContext` all equal `cannbot,glm-5.2`;
- unrelated providers and Router keys remain present;
- no Cannbot access token or virtual key appears.

- [ ] **Step 4: Run two live Claude requests through distinct Cannbot models**

Use non-interactive Claude arguments through the project CLI, first with `glm-5.2`, then with one other discovered model. Require exact marker responses and inspect only redacted logs to verify each selected model reached the managed Cannbot provider.

If the installed Claude version does not expose a non-interactive model-list command, start `cannbot-cc code`, run `/model` manually, and verify the picker visually contains the full API response. This is the only manual acceptance check.

- [ ] **Step 5: Scan for secrets, stop services, and commit documentation**

Run a pattern scan over the repository, generated project config, CCR config, and CCR logs using the credential values only as in-memory search needles; print only `SECRET_SCAN_OK` or the redacted file names containing a match. Do not print either credential.

Then:

```powershell
node dist\src\cli.js stop
node dist\src\cli.js status --json
git add README.md
git commit -m "docs: explain Cannbot model discovery"
git status --short --branch
```

Expected stopped status: `{"shim":false,"ccr":false}` with the documented non-zero status exit. Expected worktree: clean on `codex/cannbot-cc-router`.

---

## Completion Evidence

Before claiming completion, record:

- the fresh `npm run check` pass count;
- the five-or-current discovered model IDs returned by both Cannbot and `/v1/models`;
- sanitized CCR provider and four-route assertions;
- two successful live model markers;
- `SECRET_SCAN_OK`;
- clean shutdown and clean Git worktree.
