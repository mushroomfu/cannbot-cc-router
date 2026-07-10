# CCR v2/v3 Compatibility Design

## Goal

Make `cannbot-cc` manage Cannbot routing through CCR v2 and CCR v3 without changing the Claude-to-Cannbot request path or exposing Cannbot credentials.

## Scope

- Support installed CCR major versions 2 and 3.
- Preserve the existing v2 configuration and command behavior.
- Add automated v3 `init`, `sync`, `start`, `restart`, `status`, and `doctor` support.
- Support CCR v3.0.10 as the tested baseline and reject major versions other than 2 or 3 with an actionable error.

Out of scope: support for CCR v1 or a future v4; changes to Cannbot authentication; changing the existing shim protocol.

## Evidence from CCR v3.0.10

- The gateway continues to expose Anthropic-compatible `/v1/messages`, `/v1/messages/count_tokens`, and `/v1/models` endpoints.
- The gateway default is loopback port 3456, so the existing shim-to-CCR request path remains valid.
- Provider fields used by the v2 adapter (`name`, `api_base_url`, `api_key`, `models`, and `transformer`) are still parsed by v3.
- The v3 CLI provides `start` and `stop`, but not `status` or `restart`.
- v3 persists its app configuration in `config.sqlite` and its gateway keys in `api-keys.sqlite`; a legacy JSON config is only used when SQLite state is absent.

## Architecture

Introduce a `CcrAdapter` boundary. The router service will use the selected adapter for version detection, managed configuration, the CCR endpoint, and lifecycle operations. The shim, credentials module, Cannbot model discovery, and Claude launcher remain version-agnostic.

```text
RouterService
  -> detectCcrAdapter()
      -> CcrV2Adapter: config.json + CCR v2 commands
      -> CcrV3Adapter: SQLite config/key stores + CCR v3 commands and health endpoint
  -> Shim
  -> Claude launcher
```

### Version detection

`ccr version` is parsed before any CCR configuration is read or changed. Major version 2 selects `CcrV2Adapter`; major version 3 selects `CcrV3Adapter`. Missing, unparsable, or unsupported versions fail with an action that states the detected output and supported range.

### v2 adapter

The v2 adapter retains the current implementation:

- `~/.claude-code-router/config.json`
- `ccr status`, `ccr start`, `ccr stop`, `ccr restart`
- Existing JSON reconciliation and backup behavior

No v2 configuration shape, port, or command behavior changes.

### v3 adapter

The v3 adapter accesses CCR's documented-at-source SQLite layout while CCR is stopped:

- app configuration: `app_config` row with key `default` in `config.sqlite`
- gateway API keys: `api_keys` in `api-keys.sqlite`

It will load the complete JSON configuration, reconcile only the provider named `cannbot` and optional Router defaults, and write the complete value back in a single transaction. It will preserve unrelated providers, routes, profiles, and keys. The adapter adds or reuses one named local API key dedicated to `cannbot-cc`; the shim uses that key only for loopback requests to CCR.

To avoid an additional native module, the v3 adapter uses Node's built-in SQLite module by dynamic import. v3 support therefore requires the Node release that includes this module; `doctor` will provide an explicit upgrade command when it is unavailable. This restriction does not affect v2, which remains compatible with Node 20.

### v3 lifecycle and status

- `start`: run `ccr start`, then poll the configured loopback gateway `/health` endpoint.
- `status`: query `/health`; a network failure means stopped/unhealthy.
- `restart`: run `ccr stop`, wait for health to become unavailable, then run `ccr start` and wait for health.
- `stop`: run `ccr stop`, then confirm health is unavailable.

The adapter obtains the gateway port from v3 configuration; it does not assume a hard-coded port. The health polling request stays on loopback and inherits no proxy.

## Safety and recovery

- Back up each affected v3 database before its first managed update, including SQLite WAL and SHM companion files when present.
- Refuse to update v3 configuration while its gateway is healthy; lifecycle callers stop it first, and `init` reports an explicit action to stop CCR.
- Use SQLite transactions, a busy timeout, and full schema checks before mutation.
- Preserve every existing API key. Never copy Cannbot access tokens or virtual keys to CCR storage.
- Redact the local CCR API key in errors, logs, and doctor output.

## Testing

- Unit tests for version parsing and adapter selection.
- Existing v2 tests remain unchanged and run through the v2 adapter.
- Temporary SQLite fixtures for v3 configuration and API-key preservation.
- v3 lifecycle tests use a local fake `ccr` command and a local `/health` server.
- Shim option tests cover both v2 JSON and v3 adapter-provided endpoint/key values.
- Integration-style tests run reconciliation twice and assert idempotence for both versions.

## Acceptance criteria

1. `cannbot-cc doctor` identifies CCR v2 or v3 and reports a supported version.
2. `init` and `sync` add exactly one managed Cannbot provider while preserving unrelated v2 JSON or v3 SQLite state.
3. `start`, `status`, `restart`, and `stop` work for both major versions.
4. Claude Code can discover and invoke a Cannbot model through either CCR version.
5. All existing tests and added v3 tests pass without live Cannbot credentials.