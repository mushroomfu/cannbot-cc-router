# CCR v3 Runtime Gateway Port Design

## Problem

`CcrV3Adapter.loadConnection()` currently derives the CCR endpoint from the app configuration and falls back to port `3456`. CCR 3.0.3 uses `3456` for its web-management/proxy entry point and generates an inference gateway configuration on port `3457`. The shim therefore sends Claude requests to the wrong local service and receives HTTP 502 with `fetch failed`, even though the shim, CCR service, credentials, model catalog, and Cannbot upstream are healthy.

The observed runtime state is:

- CCR web-management/proxy listener: `127.0.0.1:3456`
- CCR generated inference gateway: `127.0.0.1:3457`
- generated provider endpoint: `http://127.0.0.1:8787/v1`
- shim's incorrect CCR target: `http://127.0.0.1:3456`

## Constraints

- Do not modify global Claude settings.
- Do not modify Codex `config.toml` or place Codex configuration in the router.
- Do not read or depend on `~/.cannbot/session.json`.
- Do not touch the untracked `cannbot-cc-router/` directory.
- Preserve the confirmed plain-model routing and Cannbot authentication behavior.
- Preserve CCR v2 behavior.

## Design

### Runtime gateway configuration path

Add the CCR v3 generated gateway configuration path to `ResolvedPaths`:

- Windows: `%APPDATA%/claude-code-router/gateway.config.json`
- Linux/macOS: the existing CCR v3 configuration directory plus `gateway.config.json`
- Existing internal-directory override behavior remains unchanged: the gateway file is located beside `config.sqlite` in the resolved CCR v3 configuration directory.

### Port resolution

`CcrV3Adapter.loadConnection()` will resolve the inference gateway port with this precedence:

1. A valid integer `port` from the generated `gateway.config.json`.
2. A valid explicit port from the persisted app configuration, in CCR-compatible forms:
   - `gateway.port`
   - top-level `PORT`
   - the port in top-level `routerEndpoint`
3. CCR 3.0.3's inference gateway default, `3457`.

Every accepted port must be an integer from 1 through 65535. A present but malformed generated runtime configuration is an error rather than a reason to silently route to another local service. A missing generated file is expected before the first CCR start and falls through to persisted configuration or the default.

The connection remains loopback-only:

```text
http://127.0.0.1:<resolved-gateway-port>
```

No host value from runtime or persisted configuration is trusted for the shim-to-CCR connection.

### Lifecycle compatibility

The existing startup order remains unchanged: reconcile CCR, start the shim, then start CCR. This avoids a broader lifecycle change. On first startup, the adapter can use persisted configuration or the 3457 default before CCR has generated `gateway.config.json`. On subsequent starts, the generated runtime file is the authoritative record of the actual gateway port.

### Error handling

- Missing `gateway.config.json`: continue to persisted configuration/default.
- Malformed JSON: fail with a sanitized runtime gateway configuration error.
- Invalid runtime or persisted port: fail before launching Claude.
- Runtime file I/O errors other than file-not-found: fail rather than guessing.

Errors must not include API keys, local bearer secrets, or configuration contents.

## Testing

Use TDD in `test/ccr-v3-adapter.test.ts` and path tests:

1. RED: generated `gateway.config.json` with port 3457 overrides the old 3456 fallback.
2. Generated runtime custom port is returned in the loopback base URL.
3. Missing runtime file falls back to persisted `gateway.port`, `PORT`, or `routerEndpoint`.
4. Missing all explicit port settings falls back to 3457.
5. Malformed runtime JSON and invalid ports are rejected without exposing content.
6. `resolvePaths()` returns the expected gateway configuration path on Windows, Linux, macOS, and internal-directory overrides.
7. Existing CCR v2 and v3 lifecycle, store, routing, and shim tests remain green.

## Verification

After implementation:

1. Run focused adapter/path tests.
2. Run complete `npm test`.
3. Run `npm pack --dry-run`.
4. Reinstall with `npm install -g .`.
5. Restart managed services and confirm the shim targets the gateway port from `gateway.config.json`.
6. Run `cannbot-cc doctor --json`.
7. Run the authorized minimal Claude/Cannbot end-to-end request and confirm it returns `OK` without `fetch failed`, a dual-auth warning, or `All target providers failed`.
8. Stop shim and CCR after verification.
