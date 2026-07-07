# Cannbot Model Discovery Design

## Problem

`cannbot-cc` currently configures only the selected default model in CCR. Claude Code's `/model` picker does not read CCR's `Providers` array, and CCR 2.0 does not expose a `/v1/models` endpoint or enable Claude Code gateway model discovery. As a result, the picker continues to show the model aliases from the user's existing `~/.claude/settings.json`, even though normal requests can already route through Cannbot.

The requested outcome is:

- `/model` shows every model currently reported by `cannbot models cannbot`.
- Selecting one of those models routes that request through Cannbot.
- CCR routes `default`, `think`, `background`, and `longContext` through Cannbot.
- The implementation does not modify the user's global Claude settings.
- Existing outbound Shadowsocks behavior remains supported.

## Chosen Approach

Extend the existing loopback credential shim into a small Claude-facing discovery gateway while retaining CCR as the Anthropic-to-OpenAI protocol transformer.

The alternatives were rejected for these reasons:

1. Patching the globally installed CCR package would be overwritten by upgrades and would make the project dependent on a specific minified build.
2. Claude model aliases plus `ANTHROPIC_CUSTOM_MODEL_OPTION` cannot reliably expose all five Cannbot models and would still collide with the user's global model aliases.

## Architecture

The same loopback shim process serves two distinct request paths:

```text
Claude Code
  -> shim /v1/models
       -> locally generated Cannbot model list

Claude Code
  -> shim /v1/messages
       -> CCR /v1/messages
            -> shim /v1/chat/completions
                 -> Cannbot gateway
```

Path separation prevents a proxy loop. Anthropic endpoints are forwarded inward to CCR, while the OpenAI chat-completions endpoint is forwarded outward to Cannbot.

### Model catalog

`init` and `sync` call `cannbot models cannbot`, normalize the output by removing the `cannbot/` prefix, de-duplicate model IDs, and preserve the CLI's reported order. The selected default model must be present in this catalog.

The project configuration stores model IDs only; it never stores Cannbot access tokens or virtual keys. The managed CCR provider named `cannbot` receives the complete model array instead of a single model.

The shim's authenticated `GET /v1/models` returns the OpenAI-compatible model-list shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "glm-5.2",
      "object": "model",
      "owned_by": "cannbot"
    }
  ]
}
```

Claude therefore submits the selected plain model ID, which CCR resolves against the models registered for the managed `cannbot` provider.

### CCR routing

When `--set-default` is active, reconciliation sets these managed routes to the selected default Cannbot model:

- `Router.default`
- `Router.think`
- `Router.background`
- `Router.longContext`

Each value is `cannbot,<selected-model>`. Other Router fields and providers remain untouched. Reconciliation continues to create a timestamped backup before writing.

### Claude launch behavior

`cannbot-cc code` ensures the shim and CCR are running, then launches Claude Code with a temporary settings object scoped to that child process. It does not invoke `ccr code`, because that command forces `ANTHROPIC_BASE_URL` to CCR and does not enable model discovery.

The temporary settings provide:

- `ANTHROPIC_BASE_URL` pointing to the loopback shim.
- A local shim authentication token, never a Cannbot credential.
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- Existing CCR timeout, telemetry, and cost-warning behavior required by this project.

All user-supplied Claude arguments are forwarded unchanged. The implementation uses shell-free, cross-platform command resolution already present in the project.

## Request Handling

### Claude-facing requests

The shim accepts and streams these authenticated routes to CCR:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

It replaces the inbound local shim authorization with CCR's local API key when configured. It preserves request bodies, relevant content headers, status codes, response headers, JSON responses, and SSE streams.

### Cannbot-facing requests

Existing handling for `POST /v1/chat/completions` remains unchanged:

- Cannbot credentials are read dynamically for each attempt.
- `Authorization` and `x-api-vkey` are injected only on the outbound Cannbot request.
- A single refresh and retry is allowed after a 401 or 403.
- Existing HTTP(S) or SOCKS proxy policy applies only to the outbound Cannbot connection.

Loopback traffic among Claude, the shim, and CCR always bypasses Shadowsocks through `NO_PROXY` handling.

## Security and Failure Behavior

- Every route except the existing public health check requires the local shim token.
- The shim binds only to `127.0.0.1`.
- `/v1/models` exposes model IDs only.
- Cannbot credentials must not appear in project configuration, CCR configuration, child-process arguments, output, or logs.
- If model discovery fails during `init` or `sync`, configuration is not partially written and the command reports a redacted error.
- If CCR is unavailable, Anthropic proxy routes return a sanitized 502 response.
- If the configured default model disappears from Cannbot's catalog, `sync` fails explicitly instead of silently selecting another model.
- Body-size limits and existing shutdown instance checks continue to apply.

## Testing

Automated tests will cover:

1. Model discovery normalization, ordering, de-duplication, and malformed output.
2. CCR reconciliation with all Cannbot models and all four Cannbot route categories while preserving unrelated configuration.
3. Authenticated `/v1/models` output and rejection of unauthenticated requests.
4. Anthropic JSON and SSE passthrough to a fake CCR server without credential leakage.
5. Loop prevention through explicit path routing.
6. `code` child-process settings, gateway discovery flag, argument forwarding, and Windows command resolution.
7. Error sanitization for unavailable CCR and failed Cannbot model discovery.
8. Full existing regression suite.

Live verification will start the services, confirm `/model` receives all models from `/v1/models`, run one request with `glm-5.2`, run a request with a second Cannbot model, inspect redacted routing evidence, and stop both services cleanly.

## Acceptance Criteria

- Claude Code's `/model` picker contains every current Cannbot model and does not depend on the old ZenMux aliases.
- Selecting each discovered model results in the same model ID being sent through the managed Cannbot provider.
- `default`, `think`, `background`, and `longContext` all resolve to the Cannbot provider.
- No global Claude settings are changed.
- Shadowsocks can remain enabled without intercepting loopback traffic.
- All automated checks pass and live requests through at least two Cannbot models succeed.
