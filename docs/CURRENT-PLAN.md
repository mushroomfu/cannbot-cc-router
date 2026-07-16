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
- No real model request has been sent.

## Remaining verification before completion

1. Start the real bundled CCR 3.0.6 artifact against a fake local shim, confirm gateway readiness, then dispose it. This is a no-model loopback test.
2. Run npm test, npm run build, git diff --check, package dry-run, and isolation scans.
3. Review the complete diff for secret leakage, shared-state paths, Codex references, unowned process control, and accidental changes.
4. Commit the verified implementation on the current branch.
5. Ask separately before any real cannbot-cc code prompt/model smoke test.

## Completion criteria

- The 401 regression is covered by the same explicit gateway key being seeded into private CCR and sent by the shim.
- cannbot-cc code owns and disposes its complete private chain.
- Direct claude retains the user's original configuration and API path.
- No production path accesses Codex or shared CCR state.
- Build, tests, static isolation checks, and no-model real artifact startup all pass.
- Live model traffic remains unclaimed until explicitly authorized and observed.
