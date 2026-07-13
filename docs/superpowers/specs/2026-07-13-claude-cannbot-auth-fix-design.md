# Claude and Cannbot Authentication Fix Design

## Problem

`cannbot-cc code` currently has three independent authentication compatibility failures:

1. The temporary Claude settings inject `ANTHROPIC_AUTH_TOKEN`, while Claude also loads the user's existing `apiKeyHelper`. Claude warns that both authentication sources are active.
2. The loopback shim forwards Cannbot requests with the legacy combination `Authorization: Bearer <accessToken>` and `x-api-vkey: <virtualKey>`. Cannbot CLI 1.0.1 instead supplies its `cannbot-vk` credential to the OpenAI-compatible provider as the standard Bearer credential. The legacy request reaches the Cannbot APISIX gateway but returns HTTP 500; CCR wraps this as HTTP 400 `All target providers failed`.
3. The credential reader requires a legacy `~/.cannbot/session.json` containing `accessToken`, while Cannbot CLI 1.0.1 stores its effective provider credentials in OpenCode `auth.json`. A successful `cannbot connect` therefore still leaves the router blocked before startup even though `cannbot` can list and call models normally.

The fix must preserve user, project, and local Claude settings, including permissions, hooks, plugins, and MCP configuration. It must not edit global Claude settings or expose credentials.

## Claude Authentication

For each `cannbot-cc code` session, the launcher creates a temporary directory containing the existing temporary Claude settings file and a small cross-platform Node.js API-key helper.

The temporary settings set `apiKeyHelper` to a command that runs the helper and no longer set `ANTHROPIC_AUTH_TOKEN`. Because the explicit `--settings` source overrides the same scalar key from user settings, the Cannbot helper is used only for this invocation while all unrelated user, project, and local settings continue to load normally.

The helper prints the generated loopback secret to stdout. The secret remains in a mode-0600 temporary file, matching the current protection applied to temporary settings. The entire temporary directory is deleted in the launcher's existing `finally` block on normal exit, launch failure, or child-process failure.

The helper command is generated with platform-safe quoting for Windows and POSIX paths. It uses the current Node executable so it does not depend on shell-specific scripts.

## Cannbot Provider Authentication

The router's credential boundary contains only the provider virtual key:

```ts
interface CannbotCredentials {
  virtualKey: string;
}
```

`readCredentials()` searches the existing OpenCode authentication candidates and reads only `cannbot-vk.key`. It does not read `cannbot.access`, does not read or wait for `~/.cannbot/session.json`, and does not create, migrate, or delete legacy session files. `ResolvedPaths` no longer contains `cannbotSession`.

Cannbot login, connection, and model availability are validated by the existing bounded `cannbot models cannbot` command. This keeps Cannbot CLI as the owner of OAuth refresh and model discovery while the router handles only the compatible-provider credential it actually uses.

The shim rereads the virtual key for each upstream attempt, and the outgoing model request is:

```text
Authorization: Bearer <cannbot-vk>
```

It removes inbound `authorization`, `x-api-key`, and `x-api-vkey` headers as before. It does not send the Cannbot login access token or `x-api-vkey` to the compatible-mode model endpoint.

The router does not require, return, or inspect the Cannbot login access token. Existing generic redaction continues to protect access-token-shaped fields, while credential validation and managed configuration leak checks operate only on the virtual key.

There is no fallback from legacy authentication to virtual-key Bearer authentication. Retrying an HTTP 500 with a different credential cannot prove that the first request was not processed and could duplicate a model request.

CCR v2 and CCR 3.0.x configuration remain unchanged: CCR authenticates only to the local shim using the generated local secret. The shim alone translates that local authentication into current Cannbot provider authentication.

## Error Handling and Security

- Temporary helper creation failures abort before Claude starts.
- Helper and settings paths are never logged with secret content.
- A missing OpenCode authentication file reports `AUTH_MISSING` and directs the user to run `cannbot connect`.
- Malformed OpenCode authentication JSON reports `AUTH_INVALID` without exposing file content.
- A missing or empty `cannbot-vk.key` reports `VIRTUAL_KEY_MISSING`.
- The presence, absence, or contents of `cannbot.access` do not affect router credential validation.
- Upstream response bodies continue to pass through unchanged; known credential values remain subject to existing redaction boundaries.
- A 401 or 403 retains the existing single refresh attempt. The retry rereads `cannbot-vk` before sending.
- Other status codes are returned without authentication fallback.
- User Claude settings are never rewritten, renamed, or temporarily removed.

## Testing and Verification

Automated tests will verify:

- Claude settings contain `apiKeyHelper` and omit `ANTHROPIC_AUTH_TOKEN`;
- the helper outputs the local shim secret during the child process and is deleted afterward;
- helper command construction works for Windows and POSIX paths;
- explicit Claude model and 1M-context behavior remain unchanged;
- shim requests use `Authorization: Bearer <virtualKey>`;
- shim requests omit the access token and `x-api-vkey`;
- credential loading succeeds without `~/.cannbot/session.json` and with an `auth.json` containing only `cannbot-vk.key`;
- `cannbot.access` is ignored whether present, absent, or empty;
- missing, malformed, and empty virtual-key authentication stores return the specific sanitized errors;
- 401/403 refresh and concurrent single-flight behavior still reread credentials;
- existing secret-redaction and request-forwarding guarantees remain intact.

Verification will run the complete test suite, package dry run, rebuild and reinstall the global CLI, and perform an authorized minimal end-to-end request through `cannbot-cc code --context 1m`. Success requires no dual-auth warning and a valid model response through CCR 3.0.3. The services will be stopped after verification.
