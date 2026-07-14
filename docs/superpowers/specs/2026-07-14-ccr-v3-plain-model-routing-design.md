# CCR v3 Plain-Model Routing Design

## Context

The Claude/Cannbot authentication changes are correct, but an authorized request still fails before Cannbot authentication can be evaluated. The shim currently rewrites `anthropic/cannbot/glm-5.2` to the legacy explicit route string `cannbot,glm-5.2` before forwarding the Anthropic request to CCR.

Controlled local probes against CCR 3.0.3 established one-variable evidence:

- `model: "glm-5.2"` reaches the configured loopback provider and receives the fake upstream response.
- `model: "cannbot,glm-5.2"` fails locally in approximately 2 ms with `502 {"error":{"message":"fetch failed"}}` and never reaches the fake upstream.
- The same failure occurs through the complete recursive path Claude -> shim -> CCR -> shim, without any Cannbot network access.

Therefore the remaining failure is model routing, not credential loading, header translation, proxy selection, or Cannbot availability.

## Approved Design

For namespaced Claude models, the shim will validate the requested model against its discovered Cannbot model list, remove the optional `[1m]` suffix, and forward only the plain model identifier to CCR:

```text
anthropic/cannbot/glm-5.2[1m] -> glm-5.2
```

The shim will no longer synthesize `cannbot,<model>` in the request body. CCR v3 can match the plain model against the generated provider model catalog. CCR v2 remains governed by the managed Router entries, which already select `cannbot,<model>` as the target route; the source request does not need to encode that route again.

## Preserved Behavior

- Unknown namespaced models are rejected before CCR is contacted.
- Non-namespaced model values are left unchanged.
- `/v1/messages` and `/v1/messages/count_tokens` use the same rewrite.
- Claude receives the loopback secret from the session-scoped temporary `apiKeyHelper`.
- Cannbot upstream authentication remains `Authorization: Bearer <accessToken>` plus `x-api-vkey: <virtualKey>` from OpenCode `auth.json`.
- The router never reads `~/.cannbot/session.json`, modifies global Claude settings, or modifies Codex `config.toml`.
- The untracked `cannbot-cc-router/` directory remains untouched.

## Testing

Update the existing shim-to-CCR integration assertions so normal and `[1m]` namespaced requests must contain the plain model. Verify RED against the current implementation, make the one-line production change, then run the focused proxy tests and the complete test suite. Complete package, global-install, CCR lifecycle, doctor, and authorized end-to-end verification afterward.
