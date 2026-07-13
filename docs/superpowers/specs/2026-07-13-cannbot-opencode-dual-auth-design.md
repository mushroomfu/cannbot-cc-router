# Cannbot OpenCode Dual-Authentication Correction Design

## Status and supersession

This design supersedes the virtual-key-only Cannbot credential boundary in `2026-07-13-claude-cannbot-auth-fix-design.md`. The session-scoped Claude `apiKeyHelper` design remains unchanged.

Live verification on 2026-07-13 showed that the virtual-key-only assumption was incorrect for the installed Cannbot CLI 1.0.1:

- CCR 3.0.3 generated the expected `openai_chat_completions` provider with `http://127.0.0.1:8787/v1`, so CCR provider normalization was not the failing boundary.
- The authorized Claude request reached the Cannbot target but returned HTTP 400 `All target providers failed`.
- The installed Cannbot CLI 1.0.1 provider implementation reads `cannbot.access` and `cannbot-vk.key` from OpenCode authentication, then sends `Authorization: Bearer <accessToken>` together with `x-api-vkey: <virtualKey>`.

## Goal

Mirror Cannbot CLI 1.0.1 authentication without restoring any dependency on `~/.cannbot/session.json`.

## Credential source and contract

`ResolvedPaths` continues to expose only the OpenCode `auth.json` candidates; it does not contain a legacy Cannbot session path.

`readCredentials()` reads both credentials from the first existing OpenCode authentication file:

```ts
export interface CannbotCredentials {
  accessToken: string;
  virtualKey: string;
}
```

- `cannbot.access` supplies `accessToken`.
- `cannbot-vk.key` supplies `virtualKey`.
- Missing or empty values produce `ACCESS_TOKEN_MISSING` or `VIRTUAL_KEY_MISSING`.
- Missing or malformed OpenCode authentication continues to produce `AUTH_MISSING` or `AUTH_INVALID`.
- The router never reads, creates, migrates, or deletes `~/.cannbot/session.json`.

Both values are read per upstream request. They are never copied into project configuration, CCR configuration, Claude settings, logs, or diagnostics.

## Upstream request behavior

Before forwarding to Cannbot, the shim removes inbound `authorization`, `x-api-key`, and `x-api-vkey` values. It then sets:

```text
Authorization: Bearer <accessToken>
x-api-vkey: <virtualKey>
```

The existing 401/403 single-flight validation and one retry remain unchanged and reread both credentials. HTTP 500 responses are returned without an authentication fallback.

## Claude and configuration boundaries

Claude Code continues to receive only a temporary session-level `apiKeyHelper` for the loopback gateway. The launcher does not inject `ANTHROPIC_AUTH_TOKEN` and does not modify global, project, or local Claude settings.

The router does not read or modify Codex `config.toml`. Existing CCR providers, routes, and API keys remain preserved except for the named managed Cannbot provider and routes.

## Verification

Automated tests must prove:

- credentials load from OpenCode `auth.json` without a session file;
- both `cannbot.access` and `cannbot-vk.key` are required and returned;
- the shim strips hostile inbound authentication and emits exactly the Cannbot CLI 1.0.1 header pair;
- credential refresh rereads both values once for 401/403;
- managed configuration leaks neither credential;
- generic access-token and authentication-header redaction remains intact.

Completion also requires full tests, package dry-run, global reinstall, CCR 3.0.3 lifecycle/doctor, and a newly authorized single end-to-end Claude request. The live request must contain an exact `OK` line, contain neither the dual-authentication warning nor `All target providers failed`, preserve global Claude settings, leave no launcher temporary directory, and stop shim and CCR in a `finally` block.
