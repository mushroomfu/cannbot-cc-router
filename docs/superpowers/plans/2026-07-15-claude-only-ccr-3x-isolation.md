# Claude-only CCR 3.x Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `cannbot-cc-router` so it launches only `claude` through a per-session private CCR instance, supports the verified release range `3.0.0` through `3.0.13`, and never changes Codex, global Claude settings, or shared CCR state.

**Architecture:** Preserve the current branch as evidence. In a new worktree based on `ab50a1f`, replace all global CCR reconciliation/configuration with an owned `PrivateCcrSession`. A session creates a child-only isolated environment, a current-process loopback shim, private configuration/key stores, and three private loopback ports (Web management, gateway, core). It launches direct `claude`, then disposes every owned resource in `finally`. An external CCR endpoint is supported only when the user explicitly supplies its URL and credential; it is never auto-discovered, read, started, stopped, or configured.

**Tech Stack:** TypeScript, Node.js, Node test runner, Node `node:sqlite`, existing Claude launcher, loopback HTTP shim, CCR CLI artifacts `3.0.0` through `3.0.13`.

## Authoritative Constraints

- Only `claude` may be launched as an AI client. Production code must never execute, probe for execution, wrap, or configure `codex`, `ccr code`, or another AI client.
- Production code must never read, create, write, delete, migrate, or otherwise touch `~/.codex`, `CODEX_HOME`, or equivalent Codex state. All child environments must remove `CODEX_HOME`.
- Do not read or mutate shared CCR configuration, SQLite databases, WAL/SHM files, API keys, Router, profiles, providers, model defaults, service records, or processes.
- Do not write global Claude settings. Per-session settings and helpers must live below the session root and be removed in success, failure, and interruption paths.
- Remove `--set-default` and all shared CCR lifecycle commands. `doctor` and version probing must not create schema/WAL, start or stop CCR, or inspect shared CCR storage.
- Support processes bind loopback only, use owned dynamic ports, and are never reused or killed based only on PID, name, or port.
- Never print keys, tokens, authorization headers, private CCR control output, private DB contents, or test fixture secrets.
- Do not enter, delete, move, rename, or absorb the untracked nested `cannbot-cc-router/` directory.
- Do not make real model requests until the user gives separate explicit authorization.
- Compatibility is exactly `3.0.0 <= version <= 3.0.13`; do not imply support for future `3.0.x` releases.

## Evidence and Non-Assumptions

Local static/runtime evidence for CCR `3.0.3` only:

- `CCR_INTERNAL_HOME_DIR`, `CCR_INTERNAL_APP_DATA_DIR`, and `CCR_INTERNAL_USER_DATA_DIR` are recognized; `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, XDG paths, and `TEMP/TMP` must also be set only for the child.
- The private config path is `<app-data>/claude-code-router/config.sqlite`; private keys are in `<user-data>/api-keys.sqlite`; service state is under private app-data.
- `ccr start --host --port` controls the Web-management service. The actual LLM gateway uses private configuration and needs independent gateway/core ports.
- `ccr start --no-gateway` can prove private management-service ownership/stop behavior, but it does not safely bootstrap the two databases.
- A normal start must not use default profile configuration: the private config must explicitly include `profile: { enabled: false, profiles: [] }`, disable the Codex rule, and disable system proxy, bot gateway, auto-start, and other unrelated integrations before the gateway starts.
- The v3.0.3 config/key layouts and provider shape are hypotheses to validate per artifact, not a promise for all supported releases. Keys in the v3.0.3 private key DB are not assumed encrypted; session roots need restrictive permissions and reliable deletion.

## Preconditions and Worktree Gate

- [ ] Obtain explicit user consent before creating a worktree. The current checkout is not a worktree; a separate worktree protects the failed adapter chain and the untracked nested directory.
- [ ] After consent, verify `git status --short --branch`, `git rev-parse --verify ab50a1f^{commit}`, and `git worktree list --porcelain` without resetting, cleaning, or switching the current checkout.
- [ ] Create branch `codex/claude-only-ccr-3x-isolation` from `ab50a1f` in an ignored location. Do not create it from the current adapter branch.
- [ ] Deliberately copy this plan and the hard-constraint baseline into the new worktree and commit the documentation baseline before source changes.

## Task 1: Write negative isolation contracts first

**Files:** Create `test/isolation-contract.test.ts`, `test/private-ccr-environment.test.ts`, `test/private-ccr-session.test.ts`, `test/ccr-artifact-matrix.test.ts`, and test fixtures under `test/support/`; modify version, CLI-help, CLI-args, doctor, launcher, and shim tests as their contracts change.

- [ ] Add failing tests that seed independent Codex, shared CCR, and global Claude sentinel trees. The test harness may inspect those sentinels; production code may not. Assert content, directory list, and mtime are unchanged after every success and failure path.
- [ ] Add a failing command trace that permits only `claude`, the resolved `ccr` artifact, and required read-only Cannbot tooling; it fails on `codex`, `ccr code`, unknown AI clients, and unowned process termination.
- [ ] Add failing CLI tests that retain only `code` and strictly read-only `doctor`, reject `init`, `sync`, `start`, `restart`, `stop`, `status`, and `--set-default`, and reject CCR v2, `3.0.14+`, prereleases, and malformed versions.
- [ ] Add failing lifecycle tests for normal Claude exit, failed private configuration, failed CCR start/health, failed Claude spawn, cancellation, and repeated disposal. Each test must prove that only resources created under the session root are stopped/deleted.
- [ ] Run the focused tests and confirm they fail because the private-session behavior does not yet exist. Do not add production code until that red state is observed.

## Task 2: Establish a real-artifact isolation/configuration contract

**Files:** Create `test/support/ccr-artifacts.ts`, `test/support/shared-state-sentinels.ts`, and `test/support/ccr-private-probe.ts`; modify `package.json` to add an opt-in `test:ccr-matrix` script and modify `src/ccr-version.ts` for strict artifact detection.

- [ ] Write a real artifact probe that receives an explicit package/entrypoint, makes a new session root, and starts every child with only the private environment. It must discard CCR stdout/stderr rather than capture possible management tokens.
- [ ] Verify two distinct no-model-request phases for every artifact:
  1. `ccr start --no-gateway` with a private Web port proves private service-state/stop ownership only; use the same private environment for `ccr stop` and verify no listener/state remains.
  2. A gateway phase first seeds an artifact-validated private config/key layout, then runs normal `ccr start` and waits for the configured private **gateway** port/health endpoint, not the Web `--port` endpoint.
- [ ] Configure the gateway phase with a fake model, fake non-sensitive test credentials, and a non-listening loopback provider. Do not call `/v1/messages`, `/v1/chat/completions`, or any real model endpoint.
- [ ] Before normal start, assert the private config has an empty profile array, disabled Codex rule/profile, disabled proxy/system proxy/bot gateway, disabled auto-start/login integration, explicit loopback host/ports, and only the private Cannbot provider/router/key values required for the test.
- [ ] Snapshot shared CCR, Codex, and global Claude sentinels before and after. Assert all new config/key/WAL/SHM/service artifacts are inside the session root; record only paths/categories, never values.
- [ ] Test strict detection from the actual resolved CCR artifact/package metadata, falling back to a read-only `ccr version` call only when metadata cannot be found. Accept exactly `3.0.0` through `3.0.13`.
- [ ] First run the local `3.0.3` probe. It must fail before the new private environment/store/session implementation exists.

## Task 3: Implement private environment and versioned private store with TDD

**Files:** Create `src/private-ccr-environment.ts`, `src/private-ccr-store.ts`, and `src/private-ccr-session.ts`; modify `src/ccr-version.ts`, `src/paths.ts`, `src/types.ts`, `src/command-resolution.ts`, and safe process helpers; add matching unit tests.

- [ ] Add failing unit tests for `createPrivateCcrEnvironment()` that verify all path variables are child-only, `CODEX_HOME` is removed, the parent environment is unchanged, and every generated path resolves below the session root.
- [ ] Add failing unit tests for three dynamic loopback ports, state transitions, ownership records, secret separation (gateway key versus CCR-to-shim key), redacted errors, and idempotent disposal.
- [ ] Implement the private environment with `mkdtemp`, restrictive session-root permissions where supported, and a disposer closed over the root it created. Never export an arbitrary-path recursive delete helper.
- [ ] Define versioned private layouts only from artifact evidence. A layout may create **only** the new session's `config.sqlite` and `api-keys.sqlite` tables/rows; it must validate exact schema before use, never copy/backup/migrate a user DB, never set shared WAL mode, and never read a shared location.
- [ ] Seed the private config/key databases before normal CCR start. For each supported layout, make profile suppression and Codex disabling part of the required written configuration, not an optional post-start update.
- [ ] If a release lacks a safely verified private layout, private mode must fail as an unsupported private layout. It must not fall back to global CCR state. Explicit external mode remains the only user-selected fallback.
- [ ] Run focused environment/store/session tests until green, then run `npm test`.

## Task 4: Implement owned CCR lifecycle around the correct ports

**Files:** Modify `src/private-ccr-session.ts` and its tests; reduce global behaviors in `src/processes.ts`.

- [ ] Write a failing trace test for the exact private sequence: create environment -> allocate Web/gateway/core ports -> seed private layout -> normal private `ccr start --host 127.0.0.1 --port <web-port>` -> wait for the configured gateway health -> return -> same-env `ccr stop` -> wait closed -> delete only the session root.
- [ ] Treat a control-command exit code as insufficient: readiness requires the configured gateway health. After a start attempt, cleanup may issue same-environment `ccr stop` only when a service state/artifact created under this session root proves ownership.
- [ ] Do not use `taskkill`, `process.kill` against arbitrary PIDs, fixed ports, detached processes, or health reuse. A failed bind/health check reports a private-session failure and cleans only proven-owned data.
- [ ] Discard all CCR control output. Preserve the original error if cleanup also fails, and redact all values from the cleanup error.
- [ ] Run focused lifecycle tests and the local real-artifact probe to green before router/CLI integration.

## Task 5: Wire the current-process shim and direct Claude launcher

**Files:** Modify `src/shim.ts`, `src/claude-launcher.ts`, `src/default-service.ts`, `src/router-service.ts`, `src/cli.ts`, credentials/proxy/redaction code as needed; retire `src/shim-main.ts` from the main path; add/modify launcher, shim, router, and command tests.

- [ ] Write failing tests that construct the shim from explicit private upstream URL/key values. It must not resolve a CCR adapter or read any CCR configuration/database.
- [ ] Bind the shim to `127.0.0.1:0` in the current process, obtain its actual port, and pass only that endpoint plus a temporary helper/settings file to `claude`.
- [ ] In private mode, create distinct per-session gateway and shim secrets; pass the shim port/key to the private CCR layout, and pass the gateway endpoint/key to the shim. Do not persist either secret outside the session root or process memory.
- [ ] Implement `RouterService.code()` (or its replacement) as one `try/finally` session: discover allowed artifact -> read only required Cannbot credentials/models -> start current-process shim -> create owned private CCR -> directly execute `claude` -> close CCR -> close shim -> remove temporary Claude settings.
- [ ] Implement external mode only for an explicit loopback URL plus explicitly named credential environment variable. It never calls CCR detection/start/stop/configuration and still launches direct `claude` only.
- [ ] Ensure `claude-launcher` never writes global settings and always removes its temporary directory after normal exit, spawn failure, or interruption.
- [ ] Run focused launcher/shim/router tests and then `npm test`.

## Task 6: Remove unsafe shared-state implementation and public surface

**Files:** Delete `src/ccr-v2-adapter.ts`, `src/ccr-v3-adapter.ts`, `src/ccr-v3-store.ts`, `src/ccr-config.ts`; delete/reduce global lifecycle code in `src/ccr-processes.ts`, `src/processes.ts`, `src/router-service.ts`, `src/default-service.ts`, and `src/shim-main.ts`; delete/rewrite their shared-state tests; modify `README.md`, CLI, and docs.

- [ ] Before deleting each legacy module, ensure a replacement private-session test covers its still-required behavior or intentionally removes it because it violates a hard constraint.
- [ ] Delete shared Router/default synchronization, shared DB backup/restore/migration, global `ccr start/stop/restart`, persistent shim state, and `runCcrCode()` rather than hiding them behind a flag.
- [ ] Reduce the CLI to `code` and `doctor`; make help/examples describe Claude-only private sessions, explicit external fallback, release range, and no Codex/shared-CCR management.
- [ ] Add source and runtime checks that forbid production references to `codex`, `.codex`, `CODEX_HOME`, `--set-default`, legacy adapters, shared CCR storage paths, unowned kill-by-port behavior, and `ccr code`.
- [ ] Run `npm test` and `git diff --check`.

## Task 7: Verify all artifacts and publish redacted evidence

**Files:** Modify the matrix test/package script as needed; create `docs/verification/2026-07-15-ccr-3x-isolation-matrix.md`; modify README only after actual results are known.

- [ ] Re-check the official release page before fetching artifacts. If a newer release exists, stop and update the dated scope rather than silently changing it.
- [ ] With required network authorization, download only to a temporary artifact directory; do not globally install CCR. Run every obtainable artifact `3.0.0` through `3.0.13` through both probe phases.
- [ ] A matrix pass for each version requires: strict version detection; child-only private paths; expected private schema/config; gateway health on its configured private port; same-environment owned stop; closed ports; removed session root; unchanged shared sentinels; no model request; and no secret output.
- [ ] At minimum, do not claim compatibility until `3.0.0`, local `3.0.3`, and `3.0.13` pass. The completion target remains all fourteen releases; unavailable/unsafe artifacts are recorded as unverified, not passed.
- [ ] Store only version, artifact hash, platform, schema signature, pass/fail, and cleanup result. Never store user paths, port numbers, tokens, keys, output, or request bodies.
- [ ] Run `npm test`, `npm run build`, `git diff --check`, and the static isolation scan. Review the original checkout status and confirm its branch and untracked nested directory did not change.
- [ ] Ask for a separate explicit authorization before a real Cannbot/Claude smoke request. Without it, report automated artifact/isolation evidence but do not claim live model-traffic validation.

## Completion Criteria

- [ ] Current branch evidence and the untracked nested directory remain intact.
- [ ] Only `claude` is launched as an AI client; no Codex command/path/state is accessed.
- [ ] Shared CCR, Codex, and global Claude sentinels are unchanged on success and all tested failure paths.
- [ ] Private CCR data, configuration, ports, service state, shim, and temporary Claude settings are session-owned and disposed.
- [ ] CLI/README contain no shared CCR lifecycle, `--set-default`, or Codex support claims.
- [ ] The real artifact matrix has evidence for every release `3.0.0` through `3.0.13`; no skipped artifact is represented as compatible.
- [ ] A real model smoke test is executed only after separate user approval.

## Execution update (2026-07-15)

- **Working location:** The user explicitly selected the current checkout and branch for implementation. The earlier worktree gate is superseded for this run; do not reset, clean, switch branches, or touch the untracked nested `cannbot-cc-router/` directory.
- **Artifact boundary discovered:** `3.0.0` through `3.0.2` have no public private-gateway start/stop CLI. They must not silently use shared state; their only allowed route is the explicit user-supplied external endpoint mode unless later artifact evidence establishes a safe private lifecycle.
- **Current implementation state:** strict release detection and a child-only private environment are in progress. No real model request is authorized.
