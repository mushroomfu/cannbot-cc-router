# cannbot-cc-router

cannbot-cc launches the real Claude Code CLI through a session-owned Cannbot/CCR gateway. It does not replace the claude command and does not modify Claude's normal configuration.

## Behavior boundary

- cannbot-cc code starts a private CCR 3.0.6 foreground child, an in-process loopback shim, and then executes claude.
- Typing claude directly does not run cannbot-cc; it keeps the user's original Claude home, settings, and API configuration.
- The project never launches, configures, or manages Codex.
- The project never reads or writes shared/global CCR configuration or controls a global CCR service.
- Session CCR data, Claude settings, credentials helpers, ports, and service state live below temporary private roots and are removed after success or failure.
- Cannbot credentials are read from OpenCode auth.json for each upstream request and are not copied into project, CCR, or Claude configuration.

The authoritative implementation constraints and verification state are in [docs/CURRENT-PLAN.md](docs/CURRENT-PLAN.md).

## Requirements

- Node.js 22 or newer
- Cannbot CLI, connected with cannbot connect
- Claude Code CLI available as claude

CCR is bundled as the exact npm CLI dependency @musistudio/claude-code-router@3.0.6; no global ccr installation is required or used.

## Install and build

    npm install
    npm run build
    npm link

## Usage

Launch an isolated Cannbot-backed Claude session:

    cannbot-cc code

Forward Claude arguments unchanged:

    cannbot-cc code -p "hello"
    cannbot-cc code --context 1m

Run read-only diagnostics:

    cannbot-cc doctor
    cannbot-cc doctor --json

Use native Claude with its original API configuration:

    claude

Only code and doctor are supported. There are no init, sync, start, restart, stop, status, or --set-default operations because those would imply shared CCR lifecycle or configuration ownership.

## Model discovery and authentication

On first cannbot-cc code, the project-owned ~/.cannbot-cc-router/config.json is bootstrapped from cannbot models cannbot, preferring glm-5.2 when available. This file contains model selection and a loopback secret, never Cannbot access credentials.

Claude receives temporary gateway discovery settings and an apiKeyHelper scoped to its private child environment. The shim uses a separate credential when calling the private CCR gateway. These two credentials must be non-empty and distinct, preventing the 401 caused by a missing or mismatched CCR gateway key.

## Verification

    npm test
    npm run build

The automated suite uses fake children and local loopback servers. It does not send a Cannbot model request. A real model request must be authorized separately.
