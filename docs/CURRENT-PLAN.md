# Current Plan and Hard Constraints

Last updated: 2026-07-16

This document is the authoritative continuation record for the current branch. If older design or plan documents conflict with it, this document wins.

## Objective

Make cannbot-cc code launch the real Claude Code CLI through an isolated Cannbot gateway, including model switching such as glm-5.2, with correct CCR gateway authentication.

At the same time, typing claude directly must bypass cannbot-cc completely and use the user's original Claude home, settings, and API configuration.

## Hard constraints

1. Only the real claude executable may be launched as an AI client.
2. Never launch, probe, configure, or manage Codex. Never read or write .codex, CODEX_HOME, or equivalent Codex state. Child environments remove CODEX_HOME.
3. Never read, modify, migrate, back up, or delete shared/global CCR files, databases, API keys, routes, profiles, providers, defaults, service records, or processes.
4. Never invoke ccr code, global ccr start/stop/restart/status, kill-by-port, kill-by-name, or an unowned PID.
5. The only CCR process is a foreground child created by the current cannbot-cc code session. Cleanup may signal only that exact child handle.
6. All CCR paths, Claude state paths, temporary settings/helpers, ports, and secrets are session-owned and removed in success and tested failure paths.
7. Do not write global Claude settings. Direct claude must remain behaviorally independent.
8. The CLI surface is only code and read-only doctor; no shared lifecycle commands and no --set-default.
9. Work only on the current branch. Do not switch branches, create a worktree, reset, clean, or remove the untracked nested cannbot-cc-router/ directory.
10. Do not send a real Claude/Cannbot model request without separate explicit authorization.

## Version decision

As verified on 2026-07-16:

- GitHub shows a v3.0.14 release, but that version is not published as an npm CLI artifact; npm pack returns ETARGET.
- The latest installable @musistudio/claude-code-router npm CLI is 3.0.6.
- This project therefore bundles the exact dependency 3.0.6.
- Private store parsing covers canonical npm CLI layouts 3.0.0 through 3.0.6, but runtime startup admits only the bundled and audited exact version 3.0.6. No unsupported future-version claim is made.

## Implemented architecture

    cannbot-cc code
      -> read project-owned selection and Cannbot credentials
      -> create private CCR environment and distinct dynamic ports/secrets
      -> bind current-process loopback shim
      -> seed private CCR 3.0.6 SQLite/config state
      -> spawn owned foreground CCR serve --gateway --no-open
      -> wait for its private gateway port
      -> launch real claude with a private child home/settings/helper
      -> on exit or failure: stop owned CCR child, close shim, remove private roots

Direct claude is not wrapped and follows none of this path.

## Completed

- Explicit, distinct shim-to-CCR gateway authentication; missing keys fail before listening.
- Private Claude child environment with native Anthropic/API/Codex variables removed.
- Private CCR environment, exact 3.0.6 store seeding, dynamic loopback ports, and owned foreground lifecycle.
- Private orchestration and reverse-order disposal.
- CLI reduced to code and doctor.
- Shared CCR adapters, stores, lifecycle commands, persistent shim entry, and their tests removed.
- Project path resolution reduced to project-owned configuration and Cannbot credential discovery.
- Production build passes.
- Automated suite passes when the environment permits the test helper child process; 30 compiled test files passed individually on 2026-07-16.
- Automated verification does not send real model requests; live prompts are user-initiated only.

## Claude Code model discovery compatibility

- Current verified local Claude Code version: 2.1.211.
- Claude 2.1.211 evaluates gateway model discovery from startup process.env before --settings env is applied. Supplying the discovery values only in the temporary settings file leaves /model limited to built-in Claude models and produces no gateway-models.json cache.
- Its discovery function also reads authentication synchronously before apiKeyHelper has populated its asynchronous cache. With only apiKeyHelper configured, discovery exits without making /v1/models and is not retried during startup.
- cannbot-cc code must therefore provide ANTHROPIC_BASE_URL, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1, an empty CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, and the random session shim secret as ANTHROPIC_AUTH_TOKEN directly to the private Claude child at spawn time.
- The injected token is not the user's native token, exists only in the owned child environment, and is stripped by the shim before upstream forwarding. apiKeyHelper remains as a private fallback. Direct claude is unchanged.

## Cannbot upstream authentication compatibility

- Current verified local Cannbot CLI version: 1.0.1.
- The installed Cannbot CLI provider reads the OpenCode cannbot OAuth access token and cannbot-vk API key, then sends Authorization: Bearer <accessToken> together with x-api-vkey: <virtualKey> to the compatible-mode endpoint.
- Sending the virtual key alone as the Bearer credential is incompatible with the current provider. A live glm-5.2 request reached the private CCR provider but returned 401 after the shim retried with the same wrong header mapping.
- The shim must strip all inbound authorization, x-api-key, and x-api-vkey values, then inject the freshly read access token and virtual key as the two distinct Cannbot credentials.
- On a 401 or 403, credential refresh remains single-flight and the shim rereads both credentials as one pair before its only retry.

## Verification status

- A live fresh session created gateway-models.json with all five Cannbot models, confirming Claude 2.1.211 model discovery now works.
- A user-initiated glm-5.2 prompt then reached the private CCR cannbot provider, whose usage database recorded repeated 401 responses of about 13 to 14 seconds each.
- The installed Cannbot CLI 1.0.1 binary confirmed the expected dual-header contract; the focused regression test failed with Bearer virtual-secret instead of Bearer access-secret before the shim change and passed afterward.
- Thirteen focused shim authentication, refresh, concurrency, and isolation tests pass.
- Full npm test and build pass after the dual-auth change: 78 tests, 0 failures on 2026-07-16.
- Automated verification sent no additional real model request.

Remaining live check: exit the current session, start a fresh cannbot-cc code session using the rebuilt CLI, and retry a user-initiated prompt. Do not claim a successful model response until it is observed.

## Completion criteria

- The private CCR gateway 401 regression is covered by the same explicit gateway key being seeded into private CCR and sent by the shim.
- The Cannbot upstream 401 regression is covered by matching the installed CLI's Bearer access token plus x-api-vkey contract.
- cannbot-cc code owns and disposes its complete private chain.
- Direct claude retains the user's original configuration and API path.
- Claude Code 2.1.211 starts gateway discovery and can populate /model from the authenticated private shim catalog.
- No production path accesses Codex or shared CCR state.
- Build, tests, static isolation checks, and no-model real artifact startup all pass.
- A successful live model response remains unclaimed until observed in a fresh user-run session.
