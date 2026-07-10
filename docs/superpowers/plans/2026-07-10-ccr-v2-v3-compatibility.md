# CCR v2/v3 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cannbot-cc` automatically manage a Cannbot provider through supported CCR v2 and v3 installations.

**Architecture:** Add a version-selected CCR adapter boundary. The v2 adapter preserves the JSON configuration and existing CLI lifecycle behavior; the v3 adapter updates CCR's SQLite configuration and API-key stores, then uses `ccr start`/`ccr stop` plus the gateway health endpoint for lifecycle state. Shim, Cannbot credential handling, and Claude launch remain independent of CCR generation.

**Tech Stack:** Node.js 20+, TypeScript, Node built-in `node:sqlite` dynamically loaded for CCR v3, Commander, Node test runner, local HTTP fixtures.

## Global Constraints

- Support CCR major versions exactly `2` and `3`; reject every other major version without changing CCR files.
- Preserve v2 `~/.claude-code-router/config.json` content and current command semantics.
- CCR v3 adapter must preserve unrelated providers, routes, profiles, and API keys.
- Do not persist Cannbot access tokens or virtual keys outside their existing Cannbot/OpenCode stores.
- Do not proxy loopback health, shim, or CCR traffic.
- v3 support requires a runtime that exposes `node:sqlite`; v2 remains usable on Node 20.
- Every behavior change begins with a failing test and ends with the complete suite passing.

---

### Task 1: CCR version parsing and adapter selection

**Files:**
- Create: `src/ccr-version.ts`
- Create: `test/ccr-version.test.ts`
- Modify: `src/doctor.ts`
- Test: `test/doctor.test.ts`

**Interfaces:**
- Produces `export type CcrMajorVersion = 2 | 3`.
- Produces `export function parseCcrVersion(output: string): CcrMajorVersion`.
- Produces `export async function detectCcrVersion(runner?: CapturedRunner): Promise<CcrMajorVersion>`.
- `doctor` consumes the detected version and reports `ccr-version` before CCR configuration and service checks.

- [ ] **Step 1: Write the failing version parser tests**

```ts
test("parses CCR v2 and v3 version output", () => {
  assert.equal(parseCcrVersion("claude-code-router version: 2.0.0"), 2);
  assert.equal(parseCcrVersion("claude-code-router version: 3.0.10"), 3);
});

test("rejects unknown or malformed CCR versions", () => {
  assert.throws(() => parseCcrVersion("claude-code-router version: 4.0.0"), /supported.*2.*3/i);
  assert.throws(() => parseCcrVersion("no version"), /unable to determine/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build; node --test dist/test/ccr-version.test.js`

Expected: compilation/test failure because `src/ccr-version.ts` does not exist.

- [ ] **Step 3: Implement the minimal parser and command runner**

```ts
const VERSION = /(?:claude-code-router\s+)?version:\s*(\d+)\.(\d+)\.(\d+)/i;

export function parseCcrVersion(output: string): CcrMajorVersion {
  const match = VERSION.exec(output);
  const major = Number(match?.[1]);
  if (major === 2 || major === 3) return major;
  if (match) throw new Error(`Unsupported CCR major version ${major}; supported versions are 2 and 3`);
  throw new Error("Unable to determine CCR version; run `ccr version`");
}
```

Use the existing captured-command abstraction to call `ccr version`, require exit code zero, then pass `stdout` and `stderr` combined to `parseCcrVersion`. Extend doctor dependencies with a `ccrVersion()` check and report a failure rather than continuing when it cannot detect a supported version.

- [ ] **Step 4: Run focused parser and doctor tests and verify GREEN**

Run: `npm run build; node --test dist/test/ccr-version.test.js dist/test/doctor.test.js`

Expected: all selected tests pass.

- [ ] **Step 5: Commit the isolated version-detection change**

```powershell
git add src/ccr-version.ts src/doctor.ts test/ccr-version.test.ts test/doctor.test.ts
git commit -m "feat: detect supported CCR major versions"
```

### Task 2: Define CCR adapter contracts and retain the v2 adapter

**Files:**
- Create: `src/ccr-adapter.ts`
- Create: `src/ccr-v2-adapter.ts`
- Modify: `src/ccr-processes.ts`
- Modify: `src/paths.ts`
- Modify: `src/types.ts`
- Create: `test/ccr-v2-adapter.test.ts`
- Test: `test/processes-ccr.test.ts`

**Interfaces:**
- Produces `CcrConnection { baseUrl: string; apiKey?: string; major: CcrMajorVersion }`.
- Produces `CcrAdapter` with `loadConnection`, `reconcile`, `start`, `stop`, `restart`, and `status` methods.
- Produces `createCcrAdapter(major, dependencies)` that returns `CcrV2Adapter` for major 2 and reserves the major-3 branch for Task 4.
- `ResolvedPaths` gains explicit `ccrV2Config`, `ccrV3ConfigDb`, and `ccrV3ApiKeysDb` paths while retaining `ccrConfig` as a v2 compatibility alias until all call sites are migrated.

- [ ] **Step 1: Write a failing v2 adapter behavior test**

```ts
test("v2 adapter reconciles JSON and returns its configured endpoint", async () => {
  const adapter = createCcrAdapter(2, fixtureDependencies(paths));
  await adapter.reconcile(reconcileOptions);
  assert.deepEqual(await adapter.loadConnection(), {
    major: 2,
    baseUrl: "http://127.0.0.1:4567",
    apiKey: "ccr-local-key"
  });
});
```

Create the fixture JSON with an unrelated provider, `PORT: 4567`, `APIKEY: "ccr-local-key"`, and the required `Providers`/`Router` fields. Assert that only the managed `cannbot` provider changes.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm run build; node --test dist/test/ccr-v2-adapter.test.js`

Expected: failure because `createCcrAdapter` is undefined.

- [ ] **Step 3: Extract existing v2 code behind the contract**

Move JSON loading, `reconcileCcrConfig`, command-based status/start/stop/restart, and port/APIKEY extraction into `CcrV2Adapter`. Keep the existing command timeouts and error strings. Implement `loadConnection()` from the JSON `PORT` (default `3456`) and `APIKEY` values.

```ts
export class CcrV2Adapter implements CcrAdapter {
  readonly major = 2 as const;
  async loadConnection(): Promise<CcrConnection> { /* JSON PORT/APIKEY */ }
  async reconcile(options: ReconcileOptions): Promise<void> { /* existing reconciliation */ }
  async restart(): Promise<boolean> { return restartCcr(); }
}
```

- [ ] **Step 4: Run v2 adapter and existing CCR process tests and verify GREEN**

Run: `npm run build; node --test dist/test/ccr-v2-adapter.test.js dist/test/processes-ccr.test.js dist/test/ccr-config.test.js`

Expected: all pass with unchanged v2 assertions.

- [ ] **Step 5: Commit the adapter boundary and v2 extraction**

```powershell
git add src/ccr-adapter.ts src/ccr-v2-adapter.ts src/ccr-processes.ts src/paths.ts src/types.ts test/ccr-v2-adapter.test.ts
git commit -m "refactor: isolate CCR v2 adapter"
```

### Task 3: Add a testable SQLite store for CCR v3 data

**Files:**
- Create: `src/ccr-v3-store.ts`
- Create: `test/ccr-v3-store.test.ts`
- Modify: `src/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Produces `V3StoredConfig { config: CcrConfig; apiKeys: V3ApiKey[] }`.
- Produces `openV3Store(paths): Promise<V3Store>` with `readConfig`, `writeConfig`, `readApiKeys`, `upsertManagedApiKey`, and `backupOnce`.
- `upsertManagedApiKey("cannbot-cc", localSecret)` changes only that key and returns `localSecret`.

- [ ] **Step 1: Write failing SQLite preservation tests**

```ts
test("v3 store replaces only default app configuration and preserves other API keys", async () => {
  const store = await openV3Store(paths);
  await seedV3Store(store, { Providers: [{ name: "other", models: [] }], Router: {} }, [
    { id: "other-key", key: "other-secret", name: "other" }
  ]);
  await store.writeConfig(reconciled);
  await store.upsertManagedApiKey("cannbot-cc", "local-secret");
  assert.deepEqual((await store.readConfig()).Providers.map(({ name }) => name), ["other", "cannbot"]);
  assert.deepEqual((await store.readApiKeys()).map(({ id, key }) => ({ id, key })), [
    { id: "other-key", key: "other-secret" },
    { id: "cannbot-cc", key: "local-secret" }
  ]);
});
```

Also test a second upsert updates `cannbot-cc` without duplicating it, malformed table schemas fail before any write, and backup includes database, `-wal`, and `-shm` files if they exist.

- [ ] **Step 2: Run focused store tests and verify RED**

Run: `npm run build; node --test dist/test/ccr-v3-store.test.js`

Expected: failure because `openV3Store` does not exist.

- [ ] **Step 3: Implement dynamic SQLite loading and transactional stores**

Dynamically import `node:sqlite` only from the v3 store module. On import failure, throw `CCR v3 requires a Node.js runtime with node:sqlite support`. Open both databases with a five-second busy timeout. Validate the exact tables and columns before mutation. Use transactions for `app_config.default` upsert and the managed API-key upsert; never delete existing API-key rows.

```ts
const { DatabaseSync } = await import("node:sqlite");
const database = new DatabaseSync(path);
database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
```

Back up each database and its existing SQLite companions before the first write, using a project-owned backup marker to ensure subsequent syncs do not create unrelated backup copies.

- [ ] **Step 4: Run focused SQLite and path tests and verify GREEN**

Run: `npm run build; node --test dist/test/ccr-v3-store.test.js dist/test/paths.test.js`

Expected: all tests pass on the current Node runtime; otherwise the tests must assert the documented `node:sqlite` capability error rather than silently skipping.

- [ ] **Step 5: Commit the v3 SQLite store**

```powershell
git add src/ccr-v3-store.ts src/paths.ts test/ccr-v3-store.test.ts test/paths.test.ts
git commit -m "feat: add CCR v3 SQLite configuration store"
```

### Task 4: Implement the CCR v3 adapter and health-based lifecycle

**Files:**
- Create: `src/ccr-v3-adapter.ts`
- Modify: `src/ccr-adapter.ts`
- Modify: `src/ccr-processes.ts`
- Create: `test/ccr-v3-adapter.test.ts`
- Test: `test/processes-ccr.test.ts`

**Interfaces:**
- `CcrV3Adapter` implements `CcrAdapter` with `major = 3`.
- `status(): Promise<boolean>` performs a direct loopback `GET {baseUrl}/health` request with a bounded timeout.
- `restart(): Promise<boolean>` calls `stop`, waits unhealthy, calls `start`, then waits healthy.

- [ ] **Step 1: Write failing v3 lifecycle tests**

```ts
test("v3 restart uses stop then start and waits for the health endpoint", async () => {
  const calls: string[] = [];
  const adapter = new CcrV3Adapter({
    run: async (_command, args) => { calls.push(args.join(" ")); return success; },
    health: async () => calls.includes("start")
  });
  assert.equal(await adapter.restart(), true);
  assert.deepEqual(calls, ["stop", "start"]);
});
```

Also assert that `status` does not run `ccr status`, `start` does not launch a second service if health is already ready, and a failed health wait returns an actionable timeout error.

- [ ] **Step 2: Run focused adapter test and verify RED**

Run: `npm run build; node --test dist/test/ccr-v3-adapter.test.js`

Expected: failure because `CcrV3Adapter` does not exist.

- [ ] **Step 3: Implement v3 reconciliation, connection, and lifecycle**

Use `V3Store.readConfig()` and the existing pure `reconcileCcrConfig()` to update providers/routes. Read the v3 `gateway.port` with a validated fallback of `3456`. After `upsertManagedApiKey`, return the same local key in `CcrConnection`. Implement v3 start/stop with `ccr start`/`ccr stop` and a loopback health poll; implement restart as stop then start.

```ts
async restart(): Promise<boolean> {
  await this.stop();
  await this.waitForHealth(false);
  await this.start();
  return this.waitForHealth(true);
}
```

Update the adapter factory so major 3 selects this adapter.

- [ ] **Step 4: Run v3 adapter, store, and v2 regression tests and verify GREEN**

Run: `npm run build; node --test dist/test/ccr-v3-adapter.test.js dist/test/ccr-v3-store.test.js dist/test/ccr-v2-adapter.test.js dist/test/processes-ccr.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit v3 lifecycle support**

```powershell
git add src/ccr-v3-adapter.ts src/ccr-adapter.ts src/ccr-processes.ts test/ccr-v3-adapter.test.ts
git commit -m "feat: support CCR v3 lifecycle and routing"
```

### Task 5: Route services and shim setup through the selected adapter

**Files:**
- Modify: `src/default-service.ts`
- Modify: `src/router-service.ts`
- Modify: `src/shim-main.ts`
- Modify: `src/doctor.ts`
- Modify: `test/default-service.test.ts`
- Modify: `test/router-code-launch.test.ts`
- Modify: `test/shim-main-options.test.ts`
- Create: `test/ccr-dual-version-integration.test.ts`

**Interfaces:**
- `RouterServiceDependencies` receives a single CCR adapter provider rather than separate direct CCR operations.
- `loadShimOptions` obtains `CcrConnection` through the adapter and has no direct dependency on a CCR JSON file.
- `doctor` reports `ccr-version`, `ccr-config`, and `ccr-service` using the selected adapter.

- [ ] **Step 1: Write failing v3 end-to-end fixture test**

```ts
test("v3 service reconciliation supplies the shim with the managed local API key", async () => {
  const fixture = await createV3Fixture();
  await fixture.service.init(initOptions);
  const options = await loadShimOptions(fixture.projectConfigPath);
  assert.equal(options.ccrUrl, "http://127.0.0.1:3456");
  assert.equal(options.ccrApiKey, fixture.localSecret);
  assert.equal(await fixture.hasProvider("cannbot"), true);
});
```

Add the corresponding v2 fixture assertion to prove the JSON path and configured API key still work.

- [ ] **Step 2: Run selected integration tests and verify RED**

Run: `npm run build; node --test dist/test/ccr-dual-version-integration.test.js dist/test/shim-main-options.test.js`

Expected: v3 test fails because default-service and shim-main still read v2 JSON directly.

- [ ] **Step 3: Replace direct CCR calls with adapter calls**

Construct one adapter after version detection in the default dependency factory. Pass it to initialization, sync, lifecycle, doctor, and shim option creation. Delete only obsolete direct reads after tests cover their adapter replacement. Keep `reconcileCcrConfig` pure and shared by both adapters.

- [ ] **Step 4: Run integration and all affected service tests and verify GREEN**

Run: `npm run build; node --test dist/test/default-service.test.js dist/test/router-code-launch.test.js dist/test/shim-main-options.test.js dist/test/ccr-dual-version-integration.test.js`

Expected: v2 and v3 fixture scenarios pass and no test uses real Cannbot credentials.

- [ ] **Step 5: Commit service integration**

```powershell
git add src/default-service.ts src/router-service.ts src/shim-main.ts src/doctor.ts test/default-service.test.ts test/router-code-launch.test.ts test/shim-main-options.test.ts test/ccr-dual-version-integration.test.ts
git commit -m "feat: route Cannbot services through CCR adapters"
```

### Task 6: Document support matrix, recoverability, and v3 prerequisites

**Files:**
- Modify: `README.md`
- Create: `test/cli-help.test.ts` only if the user-visible help text changes

**Interfaces:**
- README provides a CCR v2/v3 support table, the v3 Node/SQLite prerequisite, database backup locations, and recovery instructions.

- [ ] **Step 1: Write a failing documentation assertion only if CLI help changes**

```ts
test("doctor help describes CCR version detection", async () => {
  const output = await helpFor(["doctor", "--help"]);
  assert.match(output, /CCR v2 and v3/i);
});
```

Skip this test if the implementation does not change CLI help; README-only documentation needs no executable test.

- [ ] **Step 2: Update README**

Add a support matrix stating v2 JSON/commands versus v3 SQLite/health lifecycle. Document that `cannbot-cc` creates project-managed backups before the first v3 synchronization and that direct manual database edits are not needed. State that v3 needs an available `node:sqlite` runtime and show `cannbot-cc doctor` as the verification command.

- [ ] **Step 3: Run documentation-related test if added**

Run: `npm run build; node --test dist/test/cli-help.test.js`

Expected: pass, or no test run when CLI help is unchanged.

- [ ] **Step 4: Commit documentation**

```powershell
git add README.md test/cli-help.test.ts
git commit -m "docs: describe CCR v2 and v3 support"
```

### Task 7: Full regression, package verification, and live-safe checks

**Files:**
- No source changes expected unless a verification failure identifies a defect.

**Interfaces:**
- Delivers a clean worktree, all automated tests passing, and a package that contains the v2/v3 adapter runtime files.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all legacy tests and all new v3 fixture tests pass.

- [ ] **Step 2: Verify package contents and static quality**

Run: `npm pack --dry-run; git diff --check; git status --short`

Expected: package includes compiled adapter/store files, `git diff --check` is silent, and status is clean after commits.

- [ ] **Step 3: Run non-billing local command checks**

Run: `cannbot-cc doctor --help; cannbot-cc code --help`

Expected: both commands print help without contacting Cannbot or launching Claude.

- [ ] **Step 4: Ask before a live Cannbot request**

Do not run `cannbot-cc code` without a prompt-mode command until the user explicitly authorizes a request that may consume provider quota. If authorized, use a minimal prompt, run it once with the installed v2 environment, then repeat only after the user installs/selects v3.

- [ ] **Step 5: Commit any verification-only fixes, then push only with user authorization**

```powershell
git status --short
git log -1 --oneline
```

Expected: clean status and a final commit describing the last correction. Do not push unless the user asks to publish the branch.

## Self-review

- Coverage: Tasks 1–2 protect v2 and establish selection; Tasks 3–4 implement v3 storage and lifecycle; Task 5 moves all production call sites; Task 6 documents recovery; Task 7 validates package and runtime behavior.
- Placeholder scan: no implementation task defers an unspecified behavior; expected failures, APIs, commands, and file paths are named in each task.
- Type consistency: `CcrMajorVersion`, `CcrConnection`, `CcrAdapter`, and `V3Store` are introduced before consumers; v2 and v3 use the same `ReconcileOptions` and pure `reconcileCcrConfig` function.