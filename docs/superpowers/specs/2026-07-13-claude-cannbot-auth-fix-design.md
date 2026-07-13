# Claude and Cannbot Authentication Fix Design

## Problem

`cannbot-cc code` currently has two independent authentication failures:

1. The temporary Claude settings inject `ANTHROPIC_AUTH_TOKEN`, while Claude also loads the user's existing `apiKeyHelper`. Claude warns that both authentication sources are active.
2. The loopback shim forwards Cannbot requests with the legacy combination `Authorization: Bearer <accessToken>` and `x-api-vkey: <virtualKey>`. Cannbot CLI 1.0.1 instead supplies its `cannbot-vk` credential to the OpenAI-compatible provider as the standard Bearer credential. The legacy request reaches the Cannbot APISIX gateway but returns HTTP 500; CCR wraps this as HTTP 400 `All target providers failed`.

The fix must preserve user, project, and local Claude settings, including permissions, hooks, plugins, and MCP configuration. It must not edit global Claude settings or expose credentials.

## Claude Authentication

For each `cannbot-cc code` session, the launcher creates a temporary directory containing the existing temporary Claude settings file and a small cross-platform Node.js API-key helper.

The temporary settings set `apiKeyHelper` to a command that runs the helper and no longer set `ANTHROPIC_AUTH_TOKEN`. Because the explicit `--settings` source overrides the same scalar key from user settings, the Cannbot helper is used only for this invocation while all unrelated user, project, and local settings continue to load normally.

The helper prints the generated loopback secret to stdout. The secret remains in a mode-0600 temporary file, matching the current protection applied to temporary settings. The entire temporary directory is deleted in the launcher's existing `finally` block on normal exit, launch failure, or child-process failure.

The helper command is generated with platform-safe quoting for Windows and POSIX paths. It uses the current Node executable so it does not depend on shell-specific scripts.

## Cannbot Provider Authentication

The shim continues to read credentials for each upstream attempt, but the outgoing model request changes to:

```text
Authorization: Bearer <cannbot-vk>
```

It removes inbound `authorization`, `x-api-key`, and `x-api-vkey` headers as before. It does not send the Cannbot login access token or `x-api-vkey` to the compatible-mode model endpoint.

The Cannbot login access token remains part of credential validation because Cannbot CLI owns login, connection refresh, and model discovery. It is not used as the model-provider API key.

There is no fallback from legacy authentication to virtual-key Bearer authentication. Retrying an HTTP 500 with a different credential cannot prove that the first request was not processed and could duplicate a model request.

CCR v2 and CCR 3.0.x configuration remain unchanged: CCR authenticates only to the local shim using the generated local secret. The shim alone translates that local authentication into current Cannbot provider authentication.

## Error Handling and Security

- Temporary helper creation failures abort before Claude starts.
- Helper and settings paths are never logged with secret content.
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
- 401/403 refresh and concurrent single-flight behavior still reread credentials;
- existing secret-redaction and request-forwarding guarantees remain intact.

Verification will run the complete test suite, package dry run, rebuild and reinstall the global CLI, and perform an authorized minimal end-to-end request through `cannbot-cc code --context 1m`. Success requires no dual-auth warning and a valid model response through CCR 3.0.3. The services will be stopped after verification.
