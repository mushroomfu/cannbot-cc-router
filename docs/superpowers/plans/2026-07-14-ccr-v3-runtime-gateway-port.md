# CCR v3 Runtime Gateway Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route shim requests to CCR 3.0.3's actual inference gateway port instead of the web-management/proxy port that returns `502 fetch failed`.

**Architecture:** Add the generated CCR v3 `gateway.config.json` to resolved paths. The v3 adapter reads its runtime `port` first, then persisted `gateway.port`, `PORT`, or `routerEndpoint`, and finally defaults to 3457 while always constructing a loopback URL.

**Tech Stack:** TypeScript 6, Node.js 20+ (`node:test`, `node:fs/promises`, SQLite), CCR 3.0.3.

## Global Constraints

- Do not modify global Claude settings.
- Do not modify Codex `config.toml` or place Codex configuration in the router.
- Do not read or depend on `~/.cannbot/session.json`.
- Do not touch the untracked `cannbot-cc-router/` directory.
- Preserve the confirmed plain-model routing and Cannbot authentication behavior.
- Preserve CCR v2 behavior.
- Follow strict RED-GREEN-REFACTOR TDD for production changes.

---

### Task 1: Resolve the CCR v3 runtime gateway configuration path

**Files:**
- Modify: `src/types.ts`
- Modify: `src/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: existing `resolvePaths(options?: ResolvePathOptions): ResolvedPaths`.
- Produces: `ResolvedPaths.ccrV3GatewayConfig: string`, used by `CcrV3Adapter` in Task 2.

- [ ] **Step 1: Write the failing path assertions**

Add assertions without changing production types yet, so the test compiles and fails on `undefined`:

```ts
assert.equal(
  (paths as unknown as Record<string, string>).ccrV3GatewayConfig,
  join("D:\\AppData", "claude-code-router", "gateway.config.json")
);
```

In the Linux/macOS loop add:

```ts
assert.equal(
  (paths as unknown as Record<string, string>).ccrV3GatewayConfig,
  join(home, ".claude-code-router", "gateway.config.json")
);
```

In the internal-directory override test add:

```ts
assert.equal(
  (paths as unknown as Record<string, string>).ccrV3GatewayConfig,
  join("/srv/ccr-home/.claude-code-router", "gateway.config.json")
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run build
node --test dist/test/paths.test.js
```

Expected: three assertion failures where actual is `undefined` and expected paths end in `gateway.config.json`.

- [ ] **Step 3: Add the path to production types and resolution**

Add to `ResolvedPaths` in `src/types.ts`:

```ts
ccrV3GatewayConfig: string;
```

Add to the object returned by `resolvePaths()` in `src/paths.ts`:

```ts
ccrV3GatewayConfig: join(v3Dir, "gateway.config.json"),
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm run build
node --test dist/test/paths.test.js
```

Expected: all path tests pass.

- [ ] **Step 5: Commit the independently testable path change**

```powershell
git add -- src/types.ts src/paths.ts test/paths.test.ts
git commit -m "fix: resolve CCR v3 gateway runtime config"
```

### Task 2: Resolve the actual CCR v3 inference gateway port

**Files:**
- Modify: `src/ccr-v3-adapter.ts`
- Test: `test/ccr-v3-adapter.test.ts`

**Interfaces:**
- Consumes: `ResolvedPaths.ccrV3GatewayConfig`, `V3Store.readConfig()`, and the managed API key.
- Produces: `loadConnection(): Promise<CcrConnection>` and internal health checks targeting `http://127.0.0.1:<resolved-port>`.

- [ ] **Step 1: Change the existing default-port expectation to 3457**

In `v3 adapter reconciles SQLite and exposes the managed loopback key`, change only:

```ts
baseUrl: "http://127.0.0.1:3457",
```

- [ ] **Step 2: Run the focused adapter test and verify RED**

Run:

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js
```

Expected: the connection assertion fails with actual `http://127.0.0.1:3456` and expected `http://127.0.0.1:3457`.

- [ ] **Step 3: Implement only the corrected default**

Replace the two `3456` fallbacks in `configuredPort()` with a named constant:

```ts
const DEFAULT_CCR_V3_GATEWAY_PORT = 3457;
```

Return that constant when no explicit persisted port exists.

- [ ] **Step 4: Verify the default test is GREEN**

Run the focused adapter test again. Expected: all existing adapter tests pass.

- [ ] **Step 5: Add failing runtime and persisted-port tests**

Import `writeFile` from `node:fs/promises`. Add a helper that creates a reconciled adapter and returns both adapter and paths:

```ts
async function preparedAdapter(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const paths = resolvePaths({ home, platform: "linux" });
  const adapter = new CcrV3Adapter({
    paths,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => false
  });
  await adapter.reconcile(options);
  return { adapter, paths };
}
```

Add these tests:

```ts
test("v3 connection prefers the generated runtime gateway port", async () => {
  const { adapter, paths } = await preparedAdapter("cannbot-ccr-v3-runtime-");
  await writeFile(paths.ccrV3GatewayConfig, JSON.stringify({ port: 4567 }), "utf8");
  assert.equal((await adapter.loadConnection()).baseUrl, "http://127.0.0.1:4567");
});

test("v3 connection supports persisted CCR port forms before first start", async () => {
  for (const [field, value, expected] of [
    ["gateway", { port: 4568 }, 4568],
    ["PORT", 4569, 4569],
    ["routerEndpoint", "http://localhost:4570", 4570]
  ] as const) {
    const { adapter, paths } = await preparedAdapter(`cannbot-ccr-v3-${field}-`);
    const store = await openV3Store(paths);
    const config = await store.readConfig();
    await store.writeConfig({ ...config, [field]: value });
    await store.close();
    assert.equal((await adapter.loadConnection()).baseUrl, `http://127.0.0.1:${expected}`);
  }
});
```

- [ ] **Step 6: Run the focused adapter test and verify RED**

Run the focused adapter test. Expected: runtime port remains 3457, and persisted `PORT` and `routerEndpoint` cases remain 3457.

- [ ] **Step 7: Implement runtime-first port resolution**

Replace synchronous `configuredPort()` with these focused helpers in `src/ccr-v3-adapter.ts`:

```ts
const DEFAULT_CCR_V3_GATEWAY_PORT = 3457;

function validPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error("CCR v3 gateway port must be an integer from 1 to 65535");
  }
  return value as number;
}

function persistedGatewayPort(config: Record<string, unknown>): number {
  const gateway = config.gateway;
  if (gateway !== undefined && (!gateway || typeof gateway !== "object" || Array.isArray(gateway))) {
    throw new Error("CCR v3 gateway configuration is invalid");
  }
  const nested = gateway as Record<string, unknown> | undefined;
  const nestedPort = validPort(nested?.port);
  if (nestedPort !== undefined) return nestedPort;
  const topLevelPort = validPort(config.PORT);
  if (topLevelPort !== undefined) return topLevelPort;
  if (config.routerEndpoint !== undefined) {
    if (typeof config.routerEndpoint !== "string") {
      throw new Error("CCR v3 router endpoint is invalid");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(config.routerEndpoint);
    } catch {
      throw new Error("CCR v3 router endpoint is invalid");
    }
    if (endpoint.port) return validPort(Number(endpoint.port)) as number;
  }
  return DEFAULT_CCR_V3_GATEWAY_PORT;
}
```

Import `readFile` from `node:fs/promises` and add:

```ts
async function runtimeGatewayPort(path: string): Promise<number | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read CCR v3 runtime gateway configuration");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("CCR v3 runtime gateway configuration is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CCR v3 runtime gateway configuration is invalid");
  }
  const port = validPort((parsed as Record<string, unknown>).port);
  if (port === undefined) throw new Error("CCR v3 runtime gateway configuration is invalid");
  return port;
}

async function configuredPort(paths: ResolvedPaths, config: Record<string, unknown>): Promise<number> {
  return await runtimeGatewayPort(paths.ccrV3GatewayConfig) ?? persistedGatewayPort(config);
}
```

Update both call sites:

```ts
baseUrl: `http://127.0.0.1:${await configuredPort(this.dependencies.paths, config as Record<string, unknown>)}`,
```

and:

```ts
return `http://127.0.0.1:${await configuredPort(
  this.dependencies.paths,
  await store.readConfig() as Record<string, unknown>
)}`;
```

- [ ] **Step 8: Run the focused adapter test and verify GREEN**

Run:

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js
```

Expected: all adapter tests pass.

- [ ] **Step 9: Add validation regression tests**

Add:

```ts
test("v3 connection rejects malformed runtime gateway configuration", async () => {
  const { adapter, paths } = await preparedAdapter("cannbot-ccr-v3-bad-runtime-");
  await writeFile(paths.ccrV3GatewayConfig, "{broken", "utf8");
  await assert.rejects(() => adapter.loadConnection(), /runtime gateway configuration is invalid/);
});

test("v3 connection rejects invalid persisted gateway ports", async () => {
  const { adapter, paths } = await preparedAdapter("cannbot-ccr-v3-bad-port-");
  const store = await openV3Store(paths);
  const config = await store.readConfig();
  await store.writeConfig({ ...config, PORT: 0 });
  await store.close();
  await assert.rejects(() => adapter.loadConnection(), /integer from 1 to 65535/);
});
```

- [ ] **Step 10: Run focused path and adapter tests**

```powershell
npm run build
node --test dist/test/paths.test.js dist/test/ccr-v3-adapter.test.js
```

Expected: all focused tests pass and no secret-bearing values appear in errors.

- [ ] **Step 11: Commit the adapter fix**

```powershell
git add -- src/ccr-v3-adapter.ts test/ccr-v3-adapter.test.ts
git commit -m "fix: use CCR v3 runtime gateway port"
```

### Task 3: Document the CCR v3 runtime endpoint behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the runtime port behavior implemented in Task 2.
- Produces: user-facing troubleshooting guidance for distinguishing CCR web and inference ports.

- [ ] **Step 1: Add a concise CCR v3 note**

Under the CCR v3 section, add:

```markdown
CCR v3 exposes separate web-management and inference gateway ports. `cannbot-cc` reads the generated `gateway.config.json` and sends shim traffic only to the loopback inference gateway. If CCR changes its runtime port, restart with `cannbot-cc restart` so the shim reloads it.
```

- [ ] **Step 2: Verify documentation formatting**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 3: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: explain CCR v3 gateway port discovery"
```

### Task 4: Complete automated and installed-runtime verification

**Files:**
- Verify only: repository and globally installed package

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: evidence that tests, package contents, installed CLI, CCR lifecycle, and real Claude/Cannbot traffic work.

- [ ] **Step 1: Run the complete automated suite**

```powershell
npm test
```

Expected: all tests pass; the baseline grows from 103 by the new path and adapter tests.

- [ ] **Step 2: Verify package contents**

```powershell
npm pack --dry-run
```

Expected: exit 0 and `dist/src/ccr-v3-adapter.js`, `dist/src/paths.js`, and `README.md` are included.

- [ ] **Step 3: Rebuild and reinstall globally**

```powershell
npm run build
npm install -g .
```

Expected: exit 0 and `Get-Command cannbot-cc` resolves to the global npm shim.

- [ ] **Step 4: Restart and inspect the resolved runtime endpoint**

```powershell
cannbot-cc restart --set-default
cannbot-cc status --json
cannbot-cc doctor --json
```

Expected: status is `{"shim":true,"ccr":true}`, doctor reports `ok:true`, and the shim uses the port from `%APPDATA%\claude-code-router\gateway.config.json` (currently 3457).

- [ ] **Step 5: Run the authorized minimal end-to-end request**

```powershell
cannbot-cc code --context 1m -p "Reply with exactly OK" --output-format text
```

Expected: output exactly `OK`, exit 0, no `fetch failed`, no dual-auth warning, and no `All target providers failed`.

- [ ] **Step 6: Stop managed services and verify final state**

```powershell
cannbot-cc stop
cannbot-cc status --json
```

Expected: final status `{"shim":false,"ccr":false}`.

- [ ] **Step 7: Verify repository scope**

```powershell
git diff --check
git status --short --branch
```

Expected: no tracked changes remain; only the pre-existing untracked `cannbot-cc-router/` directory is listed.

- [ ] **Step 8: Use `superpowers:verification-before-completion`, `superpowers:requesting-code-review`, and `superpowers:finishing-a-development-branch`**

Review the complete branch diff against the design, address verified findings, rerun required checks, and present the four branch integration choices without assuming one.
