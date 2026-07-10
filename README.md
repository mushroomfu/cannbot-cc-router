# Cannbot CC Router

`cannbot-cc` lets Claude Code use models from a local Cannbot login through the official Claude Code Router (CCR).

```text
Claude Code
  -> loopback shim (/v1/models and Anthropic Messages)
  -> CCR (Anthropic Messages to OpenAI Chat Completions)
  -> loopback shim (/v1/chat/completions)
  -> Cannbot compatible-mode gateway
```

The shim reads the current Cannbot credentials for every upstream request. Cannbot access tokens and virtual keys are never copied into this project, CCR configuration, or Claude settings.

## Requirements

- Node.js 20 or newer
- `cannbot` with an active login and virtual key
- `@musistudio/claude-code-router` v2 or v3 (v3 requires a Node.js runtime with `node:sqlite`, such as the current Node 24 LTS)
- Claude Code

Verify the external tools:

```powershell
cannbot --version
ccr version
claude --version
```

If Cannbot credentials are missing or expired:

```powershell
cannbot auth login
cannbot connect
```

## Install

### One-time install

From this repository:

```powershell
npm install
npm run build
npm install -g .
```

The same commands work in bash and zsh. `npm install` installs the TypeScript toolchain, `npm run build` compiles to `dist/`, and `npm install -g .` registers the global `cannbot-cc` command.

### Daily start

Once installed, run `cannbot-cc code` from any directory to start the shim and CCR and launch Claude Code:

```powershell
cannbot-cc code
```

The command reads its configuration from `~/.cannbot-cc-router/`, so it is independent of the current working directory. No reconfiguration is needed between sessions; run `cannbot-cc code` whenever you want to start coding. On first use, run `cannbot-cc init --model glm-5.2 --set-default` once beforehand (see [Quick start](#quick-start)).

### 1M context for GLM-5.2

Use the explicit context option when the selected Cannbot model supports a 1M context window:

```powershell
cannbot-cc code --context 1m
```

`200k` remains the default. The command temporarily maps Claude's `sonnet[1m]` alias to the configured Cannbot model and removes the `[1m]` marker before forwarding to CCR and Cannbot. Do not add `[1m]` to `cannbot-cc init --model`, the generated CCR configuration, or a manually selected Cannbot model ID. If you pass Claude's own `--model` option, it takes precedence and is left unchanged. The actual usable context still depends on the Cannbot upstream model and your account entitlement. If the upstream rejects a 1M request, return to the default with `cannbot-cc code --context 200k`.

### Reinstall after updating the code

After pulling new changes from this repository, rebuild and reinstall so the global command picks up the new code:

```powershell
npm run build
npm install -g .
```

If `package.json` dependencies changed since the last install, run `npm install` first to update them.

## Quick start

Initialize CCR with `glm-5.2` as the default Cannbot model:

```powershell
cannbot-cc init --model glm-5.2 --proxy auto --set-default
cannbot-cc doctor
cannbot-cc start
cannbot-cc code
```

Inside Claude Code, run `/model`. The list is populated from the current output of `cannbot models cannbot`; selecting an entry such as `anthropic/cannbot/glm-5.2` does not edit `~/.claude/settings.json`.

Refresh the catalog and route CCR's default, thinking, background, and long-context categories through the selected Cannbot default:

```powershell
cannbot-cc sync --set-default
cannbot-cc restart --set-default
cannbot-cc code
```

Pass Claude Code arguments after `code` without additional quoting rules:

```powershell
cannbot-cc code -p "Reply with exactly hello" --output-format text
```

## Commands

- `cannbot-cc init`: validate the model and credentials, discover all Cannbot models, create local configuration, back up CCR, and install the managed `cannbot` provider.
- `cannbot-cc sync`: reread credentials, refresh the model catalog, and reconcile the managed CCR provider.
- `cannbot-cc start`: synchronize configuration, start the discovery/credential shim, and start CCR.
- `cannbot-cc restart`: synchronize and restart both managed services.
- `cannbot-cc stop`: stop the shim through its authenticated HTTP control endpoint and ask CCR to stop.
- `cannbot-cc status [--json]`: report shim and CCR state.
- `cannbot-cc code [--context 200k|1m] [...args]`: ensure both services are ready and launch Claude directly with temporary gateway-discovery settings. The default is `200k`; use `--context 1m` for a selected Cannbot model that supports Claude Code's 1M context alias.
- `cannbot-cc doctor [--json]`: inspect runtimes, credentials, configuration, proxy reachability, Cannbot reachability, and service state.

`init`, `sync`, `start`, and `restart` accept `--set-default` where applicable. When set, all four managed CCR route categories use `cannbot,<selected-model>`. `init` also accepts:

```text
--model <id>       Cannbot model ID (default: glm-5.2)
--proxy <mode>     auto, direct, or an HTTP/HTTPS/SOCKS proxy URL
--shim-port <port> loopback shim port (default: 8787)
```

## Shadowsocks and other proxies

`--proxy auto` honors the standard variables in this order:

- HTTPS targets: `HTTPS_PROXY`, `HTTP_PROXY`, then `ALL_PROXY`
- HTTP targets: `HTTP_PROXY`, then `ALL_PROXY`
- `NO_PROXY`/`no_proxy` always bypass matching destinations

The CLI merges `localhost` and `127.0.0.1` into `NO_PROXY`, so Claude-to-shim, shim-to-CCR, and CCR-to-shim traffic stays local. With this machine's current settings, only Cannbot HTTPS traffic uses `http://127.0.0.1:10808`; loopback traffic bypasses Shadowsocks.

To prohibit proxy use:

```powershell
cannbot-cc init --model glm-5.2 --proxy direct --set-default
```

An explicitly configured proxy failure is reported; the shim does not silently fall back to a direct connection.

## CCR v2 and v3 support

`cannbot-cc` detects the installed CCR major version through `ccr version` before it changes CCR settings.

| CCR version | Managed configuration | Service management |
| --- | --- | --- |
| v2 | `~/.claude-code-router/config.json` | `status`, `start`, `stop`, `restart` |
| v3 | CCR `config.sqlite` and `api-keys.sqlite` | `start` / `stop` plus gateway `/health` polling |

The request path is unchanged for both versions. v3 stores the project-managed local CCR key separately from Cannbot credentials; existing CCR providers and API keys are preserved. Run `cannbot-cc doctor` after installing or upgrading CCR to verify detection and configuration.
## Files and recovery

- Project-owned configuration: `~/.cannbot-cc-router/config.json`
- Shim state: `~/.cannbot-cc-router/shim-state.json`
- CCR configuration: `~/.claude-code-router/config.json`
- First CCR backup: `~/.claude-code-router/config.json.backup-YYYYMMDD-HHmmss`

The project configuration contains the non-secret discovered model IDs and a generated loopback secret. The CLI only replaces the CCR provider named `cannbot`. Other providers and unrelated router fields are preserved. Restore a backup only while CCR is stopped.

Claude gateway settings are written to a mode-0600 temporary file for the lifetime of `cannbot-cc code` and then deleted. Global Claude settings are not modified.

## Security

- The shim binds only to `127.0.0.1`.
- Claude and CCR authenticate to the shim with a generated local bearer secret.
- Shutdown requires both the bearer secret and the running shim's instance ID.
- Cannbot credentials remain in Cannbot/OpenCode's existing stores and are reread per request.
- A 401/403 triggers one bounded Cannbot validation and one retry; it cannot loop indefinitely.
- Internal errors returned to local clients omit secret-bearing details.
- Confirm that your Cannbot subscription terms permit use from Claude Code.

## Development

```powershell
npm test
npm pack --dry-run
```

The test suite uses temporary local servers and temporary home directories. Live Cannbot credentials are not used by automated tests.
