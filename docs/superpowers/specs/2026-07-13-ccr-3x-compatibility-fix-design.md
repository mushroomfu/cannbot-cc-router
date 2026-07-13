# CCR 3.0.x Cross-Platform Compatibility Fix Design

## Goal

Make `cannbot-cc` reliably support every published CCR 3.0.x release, using CCR 3.0.0 as the minimum compatibility baseline, while preserving the existing CCR v2 behavior on Windows, Linux, and macOS.

The implementation must correct the incomplete compatibility work introduced by commit `2e765ff` and must not claim support for CCR 3.1 or later without a separate validation cycle.

## Supported Versions

- CCR v2 continues to use the existing JSON configuration and command-based lifecycle adapter.
- CCR 3.0.0 through any `3.0.x` patch release uses the SQLite and health-based v3 adapter.
- CCR v1, CCR 3.1 or later, CCR v4, malformed installations, and installations whose version cannot be determined are rejected before any CCR-owned file is modified.
- Node.js 20 remains sufficient for CCR v2. CCR v3 requires a Node.js runtime that provides `node:sqlite`; the current Node 24 LTS is the recommended runtime.

## Version Detection

CCR v2 exposes `ccr version`, but the official CCR 3.0.0 CLI does not provide that subcommand. Version detection therefore cannot depend exclusively on command output.

Detection uses the following ordered strategy:

1. Resolve the actual `ccr` JavaScript entry point. On Windows this follows the npm PowerShell or CMD shim; on POSIX it follows executable symlinks. Reuse the project's existing command-resolution behavior rather than invoking a shell.
2. Walk upward from the resolved entry point to the owning `package.json` and require its package name to equal `@musistudio/claude-code-router`.
3. Parse the package version as an exact semantic version. Select the v3 adapter only for major `3`, minor `0`, and any non-negative patch version.
4. If package metadata cannot be located, run the legacy `ccr version` probe and parse its output. This preserves CCR v2 and compatible legacy installations.
5. If neither source produces a supported version, fail with an actionable error without reading or writing CCR configuration.

The detector returns the full semantic version plus the selected adapter generation so `doctor` can report the actual release rather than only `v2` or `v3`.

## Cross-Platform Storage Layout

The adapter follows CCR 3.0.0's official data layout and honors the same internal directory overrides used by CCR.

| Platform | `config.sqlite` | `api-keys.sqlite` |
| --- | --- | --- |
| Windows | `%APPDATA%\claude-code-router\config.sqlite` | `%APPDATA%\claude-code-router\api-keys.sqlite` |
| Linux | `~/.claude-code-router/config.sqlite` | `~/.claude-code-router/app-data/api-keys.sqlite` |
| macOS | `~/.claude-code-router/config.sqlite` | `~/.claude-code-router/app-data/api-keys.sqlite` |

When set, `CCR_INTERNAL_HOME_DIR`, `CCR_INTERNAL_APP_DATA_DIR`, and `CCR_INTERNAL_USER_DATA_DIR` take precedence using CCR's own meanings. Path tests cover default and overridden layouts on all three platforms.

## Safe v3 Reconciliation

Direct `init` and `sync` operations must not update CCR v3 while the configured gateway health endpoint is available. They fail with an instruction to stop CCR first.

Managed lifecycle commands coordinate the update:

- `start`: if CCR is running, stop it and confirm the health endpoint is unavailable; reconcile; start the shim; start CCR and wait for health.
- `restart`: stop the shim and CCR, confirm CCR is unavailable, reconcile, start the shim, then start CCR and wait for health.
- `stop`: stop the shim and CCR and confirm the gateway is unavailable.
- `status`: query the loopback health endpoint directly without inheriting proxy settings.

The adapter derives the gateway host and port from the complete v3 configuration. Wildcard hosts are converted to loopback for local health and shim requests. Only loopback HTTP endpoints are accepted.

## SQLite Validation, Backup, and Recovery

Before any mutation, the v3 store opens both databases with a bounded busy timeout and validates the complete required schema:

- `app_config`: `key`, `value_json`, `updated_at` with the expected primary key and required text columns.
- `api_keys`: `id`, `name`, `encrypted_key`, `encryption`, `created_at`, `expires_at`, and `limits_json` with the expected primary key and required columns.

Schema validation finishes for both databases before either database is changed. Existing tables with missing or incompatible fields are rejected; the adapter does not repair CCR-owned schemas.

The store then creates one consistent backup set containing both databases and their existing `-wal` and `-shm` companions. CCR must be stopped before the backup, preventing files from changing during the copy. A project marker records the completed backup directory.

The configuration and API keys live in separate SQLite databases, so one SQLite transaction cannot cover both without attaching databases and changing CCR's connection model. Reconciliation therefore uses a compensating transaction:

1. Validate both schemas and parse the complete configuration.
2. Create or confirm the one-time backup.
3. Update `app_config.default` in a transaction.
4. Upsert only API key ID `cannbot-cc` in a transaction.
5. If either update fails, close both stores and restore the complete backup set before reporting failure.

The update preserves all unrelated top-level configuration, providers, routes, profiles, plugins, and API keys. It replaces only the provider named `cannbot`, the optional managed route values, and API key ID `cannbot-cc`. Cannbot access tokens and virtual keys never enter CCR storage.

## Doctor Behavior

`cannbot-cc doctor` reports the exact detected CCR version and selected adapter. Its v3 configuration check verifies all of the following without printing secret values:

- the resolved database locations match the selected platform and overrides;
- both database schemas are valid;
- exactly one managed `cannbot` provider exists;
- the managed provider contains the complete current model catalog and loopback shim endpoint;
- managed routes, when configured, reference the selected Cannbot model;
- API key ID `cannbot-cc` exists and matches the project-owned local secret;
- Cannbot access tokens and virtual keys are absent from project and CCR configuration.

Missing or malformed managed state produces a failing check with an actionable `init` or `sync` instruction.

## Testing

All production behavior changes follow a red-green-refactor cycle.

Automated coverage includes:

- version detection through realistic Windows npm shims and POSIX symlinks when `ccr version` is unavailable;
- acceptance of `3.0.0` and later `3.0.x` patch versions, with rejection of v1, v3.1+, v4, malformed versions, and mismatched package names;
- Windows, Linux, and macOS default and overridden database paths;
- refusal to reconcile while the v3 gateway is healthy;
- complete schema rejection before the first write;
- restoration after a forced second-database write failure;
- two consecutive reconciliations proving idempotence and preservation of unrelated configuration and API keys;
- v2 regression coverage through the unchanged adapter behavior;
- `doctor` failures for a missing provider, model, route, or managed key;
- lifecycle tests using a fake CCR 3.0 CLI and a real local `/health` server rather than health-only mocks;
- contract fixtures derived from the official CCR 3.0.0 package and the newest published 3.0.x package.

The final automated gate is:

```powershell
npm test
npm pack --dry-run
git diff --check
git status --short
```

## Local Upgrade and Live-Safe Verification

After the automated fixes are complete:

1. Record the current `ccr version`, executable path, service state, and existing CCR configuration locations.
2. Stop CCR and back up existing local CCR data.
3. Install `@musistudio/claude-code-router@3.0.0` globally.
4. Verify the installed package version from package metadata and confirm its real database paths.
5. Run `cannbot-cc init`, `sync`, `start`, `status`, `restart`, `stop`, and `doctor` against the real CCR 3.0.0 installation.
6. Upgrade to the newest published CCR 3.0.x release and repeat the non-billing lifecycle and doctor checks.
7. Do not run `cannbot-cc code` or send a model request unless the user separately authorizes quota-consuming validation.

If a live check changes user-owned CCR state, the existing backups remain available and the handoff reports their exact locations.

## Acceptance Criteria

1. Official CCR 3.0.0 is detected without relying on a nonexistent `ccr version` command.
2. All published CCR 3.0.x patch releases select the v3 adapter; unvalidated generations are rejected before mutation.
3. Windows, Linux, and macOS resolve the same storage locations as CCR itself.
4. v3 configuration is never modified while the gateway is healthy.
5. Schema errors and partial update failures leave the original databases recoverable and unchanged after restoration.
6. Reconciliation remains idempotent and preserves all unrelated CCR state.
7. `doctor` verifies actual managed provider, routing, and key state.
8. Existing v2 behavior and tests remain passing.
9. The complete automated suite and package checks pass.
10. Real Windows lifecycle checks pass on CCR 3.0.0 and the newest available 3.0.x without consuming Cannbot model quota.
