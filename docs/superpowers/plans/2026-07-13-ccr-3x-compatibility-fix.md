# CCR 3.0.x Cross-Platform Compatibility Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably support CCR 3.0.0 through every 3.0.x patch release on Windows, Linux, and macOS while preserving CCR v2 behavior.

**Architecture:** Resolve the installed CCR package entry and read its package metadata before falling back to the legacy version command. Route v2 and v3 through the existing adapter boundary, but make v3 paths match CCR's platform layout, validate both SQLite schemas before mutation, prevent live writes, and restore a complete backup if a two-database update partially fails.

**Tech Stack:** TypeScript 6, Node.js 20/24, Node `node:sqlite`, Node test runner, npm global packages, local HTTP fixtures.

## Global Constraints

- Support CCR v2 and CCR 3.0.x only; reject v1, v3.1+, v4, malformed versions, and mismatched packages before mutation.
- CCR v2 behavior and Node.js 20 compatibility remain unchanged.
- CCR v3 requires `node:sqlite`; recommend Node.js 24 LTS.
- Preserve unrelated providers, routes, profiles, plugins, and API keys.
- Never write Cannbot access tokens or virtual keys to CCR-owned files.
- Never mutate CCR v3 SQLite files while the gateway is healthy.
- Use test-first red-green-refactor for every production change.
- Do not send a Cannbot model request during live verification.

---

## File Structure

- `src/command-resolution.ts`: resolve the executable and expose its JavaScript entry for package ownership checks.
- `src/ccr-version.ts`: parse supported semantic versions and detect the installed package version.
- `src/paths.ts`: mirror CCR v3 platform and environment-override storage layout.
- `src/ccr-v3-store.ts`: validate, back up, update, restore, and inspect v3 SQLite state.
- `src/ccr-v3-adapter.ts`: enforce stopped-state reconciliation and health-based lifecycle behavior.
- `src/router-service.ts`: order stop/reconcile/start operations safely for managed lifecycle commands.
- `src/default-service.ts`: construct adapters and perform full doctor validation.
- `src/doctor.ts`: report the exact CCR version.
- `test/ccr-version.test.ts`: package metadata, legacy fallback, and supported-range tests.
- `test/paths.test.ts`: Windows, Linux, macOS, and environment override tests.
- `test/ccr-v3-store.test.ts`: schema, rollback, preservation, and idempotence tests.
- `test/ccr-v3-adapter.test.ts`: healthy-write refusal and real HTTP lifecycle tests.
- `test/commands.test.ts`: safe service operation ordering.
- `test/default-service.test.ts` and `test/doctor.test.ts`: complete managed-state diagnostics.

---

### Task 1: Detect CCR 3.0.x From Installed Package Metadata

**Files:**
- Modify: `src/command-resolution.ts`
- Modify: `src/ccr-version.ts`
- Modify: `src/doctor.ts`
- Modify: `src/default-service.ts`
- Modify: `test/ccr-version.test.ts`
- Modify: `test/doctor.test.ts`

**Interfaces:**
- Produces: `ResolvedCommand.entry?: string` from `resolveCommandSync`.
- Produces: `DetectedCcrVersion { major: 2 | 3; version: string }`.
- Produces: `parseSupportedCcrVersion(version: string): DetectedCcrVersion`.
- Produces: `detectCcrVersion(dependencies?): Promise<DetectedCcrVersion>`.

- [ ] **Step 1: Write failing package metadata and range tests**

Create temporary package layouts in `test/ccr-version.test.ts`. The Windows fixture contains an npm `.cmd` shim pointing at `node_modules/@musistudio/claude-code-router/dist/main/cli.js`; the POSIX fixture passes the resolved entry directly. Assert:

```ts
assert.deepEqual(await detectCcrVersion({
  resolve: async () => ({ command: process.execPath, prefixArgs: [entry], entry }),
  run: async () => ({ code: 1, stdout: "", stderr: "" })
}), { major: 3, version: "3.0.0" });

assert.deepEqual(parseSupportedCcrVersion("3.0.3"), { major: 3, version: "3.0.3" });
assert.throws(() => parseSupportedCcrVersion("3.1.0"), /supported.*3\.0\.x/i);
assert.throws(() => parseSupportedCcrVersion("4.0.0"), /supported/i);
```

Add a mismatched package-name fixture and assert it is rejected. Retain a legacy runner fixture that returns `claude-code-router version: 2.0.0` and assert `{ major: 2, version: "2.0.0" }`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm run build
node --test dist/test/ccr-version.test.js dist/test/doctor.test.js
```

Expected: compilation fails because `DetectedCcrVersion`, package dependencies, and the new return type do not exist.

- [ ] **Step 3: Expose the resolved JavaScript entry**

Extend `CommandResolution`:

```ts
export interface CommandResolution {
  command: string;
  prefixArgs: string[];
  entry?: string;
}
```

When an npm CMD shim resolves to a Node entry, return `{ command: process.execPath, prefixArgs: [entry], entry }`. For a POSIX absolute executable or symlink, resolve its real path and expose it as `entry`; unresolved command names retain no entry.

- [ ] **Step 4: Implement metadata-first exact version detection**

In `src/ccr-version.ts`, walk from `dirname(entry)` toward the filesystem root. For each `package.json`, parse JSON and accept only:

```ts
interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}
```

Require `name === "@musistudio/claude-code-router"`. Parse versions with `/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/`; accept major 2 with any minor/patch and major 3 only when minor is zero. If metadata lookup fails, call `ccr version` and apply the same supported-range check to its parsed full version.

- [ ] **Step 5: Update adapter selection and doctor output**

Use `detected.major` in `resolveCcrAdapter`. Change `DoctorDependencies.ccrVersion()` to return `DetectedCcrVersion` and report `CCR 3.0.0 is supported` rather than only `CCR v3 is supported`. Change the executable check for `ccr` to successful package resolution or detection, not a separate `ccr version` command.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npm run build
node --test dist/test/ccr-version.test.js dist/test/doctor.test.js dist/test/windows-command*.test.js
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit the detector fix**

```powershell
git add src/command-resolution.ts src/ccr-version.ts src/doctor.ts src/default-service.ts test/ccr-version.test.ts test/doctor.test.ts test/windows-command.test.ts
git commit -m "fix: detect installed CCR 3.0.x packages"
```

---

### Task 2: Match CCR v3 Paths on Every Platform

**Files:**
- Modify: `src/paths.ts`
- Create: `test/paths.test.ts`

**Interfaces:**
- `resolvePaths(options)` continues to produce `ccrV3ConfigDb` and `ccrV3ApiKeysDb`.
- Consumes CCR directory overrides `CCR_INTERNAL_HOME_DIR`, `CCR_INTERNAL_APP_DATA_DIR`, and `CCR_INTERNAL_USER_DATA_DIR`.

- [ ] **Step 1: Write failing platform path tests**

Assert exact normalized paths:

```ts
assert.equal(resolvePaths({ home: "/home/u", platform: "linux", env: {} }).ccrV3ApiKeysDb,
  join("/home/u", ".claude-code-router", "app-data", "api-keys.sqlite"));
assert.equal(resolvePaths({ home: "/Users/u", platform: "darwin", env: {} }).ccrV3ApiKeysDb,
  join("/Users/u", ".claude-code-router", "app-data", "api-keys.sqlite"));
assert.equal(resolvePaths({ home: "C:\\Users\\u", platform: "win32", env: { APPDATA: "D:\\AppData" } }).ccrV3ApiKeysDb,
  join("D:\\AppData", "claude-code-router", "api-keys.sqlite"));
```

Add overrides asserting that internal home controls non-Windows config location and internal user data controls the API-key directory.

- [ ] **Step 2: Run focused test and verify RED**

```powershell
npm run build
node --test dist/test/paths.test.js
```

Expected: Linux/macOS API-key path assertions fail because `app-data` is absent.

- [ ] **Step 3: Implement CCR-compatible directory resolution**

Create small helpers equivalent to CCR's meanings: app home is `%APPDATA%\claude-code-router` on Windows and `~/.claude-code-router` elsewhere; user data is app home on Windows and `<app-home>/app-data` elsewhere. Apply internal environment overrides before defaults.

- [ ] **Step 4: Run path and existing filesystem tests and verify GREEN**

```powershell
npm run build
node --test dist/test/paths.test.js dist/test/default-service.test.js dist/test/shim-main-options.test.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the path fix**

```powershell
git add src/paths.ts test/paths.test.ts
git commit -m "fix: match CCR v3 storage paths"
```

---

### Task 3: Validate and Recover v3 SQLite Updates

**Files:**
- Modify: `src/ccr-v3-store.ts`
- Modify: `test/ccr-v3-store.test.ts`

**Interfaces:**
- Produces: `V3Store.validate(): Promise<void>`.
- Produces: `V3Store.inspect(): Promise<{ config: CcrConfig; apiKeys: V3ApiKey[] }>`.
- Produces: `reconcileV3Store(paths, mutate): Promise<void>` or an equivalent single coordinator that validates, backs up, writes, and restores.
- Produces: `restoreV3Databases(paths, backupDir): Promise<void>`.

- [ ] **Step 1: Write a failing malformed-schema test**

Create `config.sqlite` with `app_config(key TEXT PRIMARY KEY)` and a valid API-key schema. Capture both database hashes, call reconciliation, assert rejection matches `/schema.*app_config/i`, and assert both hashes are unchanged.

- [ ] **Step 2: Run the malformed-schema test and verify RED**

```powershell
npm run build
node --test --test-name-pattern="schema" dist/test/ccr-v3-store.test.js
```

Expected: failure because `CREATE TABLE IF NOT EXISTS` does not validate columns before mutation.

- [ ] **Step 3: Implement complete schema inspection**

Use `PRAGMA table_info(app_config)` and `PRAGMA table_info(api_keys)`. Compare column name, type, `notnull`, and primary-key position against exact required definitions. Run validation for both open databases before executing any insert or update. Keep table creation only for truly absent fresh databases.

- [ ] **Step 4: Write and verify RED for partial-update restoration**

Inject an API-key write dependency that throws after the config transaction commits. Seed unrelated provider, profile, route, and key values. Assert reconciliation rejects and both post-failure database contents equal the pre-update contents.

Run:

```powershell
npm run build
node --test --test-name-pattern="restores" dist/test/ccr-v3-store.test.js
```

Expected: failure because no restore coordinator exists.

- [ ] **Step 5: Implement consistent backup and compensating restore**

Require both schemas to validate, close/checkpoint live handles, copy each database plus existing WAL/SHM companions, then reopen for writes. Wrap each database mutation in `BEGIN IMMEDIATE` / `COMMIT` with rollback on error. On any failure after the backup, close handles, replace both database sets from the backup directory, and rethrow a redacted error.

- [ ] **Step 6: Add idempotence and preservation coverage**

Run two reconciliations. Assert exactly one `cannbot` provider, exactly one `cannbot-cc` key, unchanged unrelated providers/profiles/plugins/routes/keys, and identical managed values after the second run.

- [ ] **Step 7: Run all store tests and verify GREEN**

```powershell
npm run build
node --test dist/test/ccr-v3-store.test.js dist/test/ccr-config.test.js
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit store safety fixes**

```powershell
git add src/ccr-v3-store.ts test/ccr-v3-store.test.ts
git commit -m "fix: make CCR v3 database updates recoverable"
```

---

### Task 4: Enforce Stopped-State Reconciliation and Safe Lifecycle Order

**Files:**
- Modify: `src/ccr-v3-adapter.ts`
- Modify: `src/router-service.ts`
- Modify: `src/default-service.ts`
- Modify: `test/ccr-v3-adapter.test.ts`
- Modify: `test/commands.test.ts`

**Interfaces:**
- `CcrAdapter.reconcile` remains the managed configuration entry point.
- v3 `reconcile` rejects when health is true.
- `RouterService.start/restart` stop a running v3 service before reconciliation through adapter-neutral dependencies.

- [ ] **Step 1: Write a failing healthy-reconciliation test**

Seed both databases, set `health: async () => true`, call `adapter.reconcile(options)`, and assert rejection matches `/stop CCR/i`. Compare database contents before and after to prove no write occurred.

- [ ] **Step 2: Run focused adapter test and verify RED**

```powershell
npm run build
node --test --test-name-pattern="running|healthy" dist/test/ccr-v3-adapter.test.js
```

Expected: failure because current reconciliation writes regardless of health.

- [ ] **Step 3: Add the adapter write guard**

At the beginning of v3 reconciliation, resolve the configured loopback base URL and call health. If healthy, throw `CCR v3 is running; stop CCR before synchronizing configuration` before backup or store mutation.

- [ ] **Step 4: Write failing command-order tests**

For `start` from a running state, require trace order `load-config`, `ccr-status`, `stop-ccr`, `reconcile`, `start-shim`, `start-ccr`. For `restart`, require shim and CCR stop before reconciliation. Retain the v2 trace expectations where CCR is already stopped.

- [ ] **Step 5: Run command tests and verify RED**

```powershell
npm run build
node --test dist/test/commands.test.js
```

Expected: trace mismatch because `sync` currently reconciles before lifecycle checks.

- [ ] **Step 6: Implement safe orchestration**

Split credential/catalog refresh from configuration mutation. `start` and `restart` query CCR status, stop it when active, reconcile only after confirmed stop, then start services. Direct `sync` remains non-destructive when the v3 adapter reports running. Do not expose v3-specific conditionals from `RouterService`; express the behavior through adapter/dependency methods.

- [ ] **Step 7: Replace the lifecycle mock with a local health server**

In `test/ccr-v3-adapter.test.ts`, start a loopback HTTP server exposing `/health`. The fake run dependency toggles server availability for `start` and `stop`. Verify `status`, `start`, `restart`, and `stop` with bounded waits and no `ccr status` invocation.

- [ ] **Step 8: Run lifecycle tests and verify GREEN**

```powershell
npm run build
node --test dist/test/ccr-v3-adapter.test.js dist/test/commands.test.js dist/test/processes-ccr.test.js
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit lifecycle safety fixes**

```powershell
git add src/ccr-v3-adapter.ts src/router-service.ts src/default-service.ts test/ccr-v3-adapter.test.ts test/commands.test.ts
git commit -m "fix: synchronize CCR v3 only while stopped"
```

---

### Task 5: Validate Complete Managed State in Doctor

**Files:**
- Modify: `src/ccr-adapter.ts`
- Modify: `src/ccr-v2-adapter.ts`
- Modify: `src/ccr-v3-adapter.ts`
- Modify: `src/default-service.ts`
- Modify: `src/doctor.ts`
- Modify: `test/default-service.test.ts`
- Modify: `test/doctor.test.ts`

**Interfaces:**
- Produces: `CcrAdapter.validateManagedState(project: ProjectConfig): Promise<void>`.
- Doctor reports exact `DetectedCcrVersion.version`.

- [ ] **Step 1: Write failing v3 managed-state tests**

Create separate fixtures missing: the `cannbot` provider, one selected model, a configured managed route, and API key `cannbot-cc`. Call the doctor configuration dependency and assert each fixture rejects. Add a valid fixture containing unrelated providers and keys and assert it passes without returning secret values.

- [ ] **Step 2: Run focused doctor tests and verify RED**

```powershell
npm run build
node --test dist/test/default-service.test.js dist/test/doctor.test.js
```

Expected: missing provider/model/route fixtures incorrectly pass because only the API key is checked.

- [ ] **Step 3: Implement adapter-owned managed-state validation**

For v3, validate schema, load the complete config and keys, require exactly one `cannbot` provider, exact model catalog, expected loopback shim endpoint, configured managed routes, and a `cannbot-cc` key matching `project.localSecret`. For v2, reuse pure reconciliation validation plus the existing connection rules without changing v2 files.

- [ ] **Step 4: Improve doctor actions and exact version detail**

Keep errors secret-free. Report the exact supported version and return an `init`/`sync` action for invalid managed state. If CCR v3 runs under Node without `node:sqlite`, report `Install Node.js 24 LTS`.

- [ ] **Step 5: Run focused and full tests and verify GREEN**

```powershell
npm run build
node --test dist/test/default-service.test.js dist/test/doctor.test.js dist/test/ccr-v2-adapter.test.js dist/test/ccr-v3-adapter.test.js
npm test
```

Expected: focused tests and the complete suite pass with zero failures.

- [ ] **Step 6: Commit doctor validation**

```powershell
git add src/ccr-adapter.ts src/ccr-v2-adapter.ts src/ccr-v3-adapter.ts src/default-service.ts src/doctor.ts test/default-service.test.ts test/doctor.test.ts
git commit -m "fix: validate managed CCR state in doctor"
```

---

### Task 6: Package Contracts, Local CCR Upgrade, and Live Verification

**Files:**
- Modify: `README.md`
- Test: complete suite and official package fixtures

**Interfaces:**
- Documents CCR v2 and 3.0.x support, Node requirements, paths, stop-before-sync rule, backups, and recovery.

- [ ] **Step 1: Download official contract packages to a temporary directory**

```powershell
npm pack @musistudio/claude-code-router@3.0.0 --pack-destination $env:TEMP
npm pack @musistudio/claude-code-router@3.0.3 --pack-destination $env:TEMP
```

Extract package metadata and assert package name/version, CLI entry, database table definitions, and platform storage layout match the fixture assumptions. Do not commit the tarballs.

- [ ] **Step 2: Update README support and recovery documentation**

State support as CCR v2 and CCR 3.0.x, document platform database paths and Node 24 for v3, require stopping v3 before direct sync, and document the project backup marker and complete restore procedure.

- [ ] **Step 3: Run the final automated gate**

```powershell
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: all tests pass; package contains every adapter/version/store module; diff check is silent; only intended README changes are uncommitted.

- [ ] **Step 4: Record and protect the current local CCR v2 state**

```powershell
ccr version
Get-Command ccr | Format-List Source,Path
ccr status
```

Resolve and copy the existing CCR configuration directory into a timestamped backup under `~/.cannbot-cc-router/` while CCR is stopped. Record the exact backup path.

- [ ] **Step 5: Install and verify official CCR 3.0.0**

```powershell
npm install -g @musistudio/claude-code-router@3.0.0
```

Read the installed package's `package.json` and assert version `3.0.0`. Confirm the executable path and database locations. Do not use `ccr version`, which is not a v3 command.

- [ ] **Step 6: Rebuild and install the local cannbot CLI**

```powershell
npm run build
npm install -g .
```

Verify `cannbot-cc --help` and `cannbot-cc doctor --json` detect CCR 3.0.0.

- [ ] **Step 7: Run non-billing CCR 3.0.0 lifecycle acceptance**

With the user's existing Cannbot login but without a model request, run:

```powershell
cannbot-cc init --model glm-5.2 --proxy auto --set-default
cannbot-cc sync --set-default
cannbot-cc start
cannbot-cc status --json
cannbot-cc restart --set-default
cannbot-cc doctor --json
cannbot-cc stop
```

Expected: all commands succeed except documented non-zero stopped status behavior after the final stop; no request reaches a Cannbot inference endpoint.

- [ ] **Step 8: Verify newest published CCR 3.0.x**

Query the official npm registry for the newest version matching `3.0.x`, install that exact version, then repeat `doctor`, `start`, `status`, `restart`, and `stop`. If the newest published patch remains 3.0.3, install `@musistudio/claude-code-router@3.0.3`.

- [ ] **Step 9: Commit documentation and any verification-only fixture updates**

```powershell
git add README.md test
git commit -m "docs: document verified CCR 3.0.x support"
```

- [ ] **Step 10: Run final verification after the last commit**

```powershell
npm test
npm pack --dry-run
git diff --check HEAD^ HEAD
git status --short
git log -3 --oneline
```

Expected: all automated checks pass and the worktree is clean.

---

## Self-Review

- Spec coverage: version detection, supported range, platform paths, live-write refusal, schema validation, backup/restore, idempotence, doctor validation, v2 regression, package contracts, and real Windows verification each have a dedicated task.
- Placeholder scan: no deferred implementation or unspecified error handling remains.
- Type consistency: `DetectedCcrVersion`, the extended command resolution result, `CcrAdapter.validateManagedState`, and v3 store validation/inspection are introduced before their consumers.
- Scope: the plan changes only CCR compatibility, safety, diagnostics, tests, and documentation; Cannbot authentication and request protocol behavior remain unchanged.
