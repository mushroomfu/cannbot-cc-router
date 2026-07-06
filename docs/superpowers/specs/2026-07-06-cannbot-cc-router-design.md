# Cannbot CC Router Design

## Goal

Build a cross-platform Node.js CLI that lets Claude Code use the user's Cannbot subscription through the official `@musistudio/claude-code-router` (CCR), without embedding Cannbot credentials in CCR configuration.

The first verified model is `cannbot/glm-5.2`. The implementation targets Node.js 20 or newer and Windows, macOS, and Linux.

## Scope

The CLI provides these commands:

- `cannbot-cc init`: select and persist the Cannbot model, install the managed CCR provider, and create the first timestamped CCR configuration backup.
- `cannbot-cc sync`: validate Cannbot login state and reconcile the managed CCR provider without changing unrelated providers or router fields.
- `cannbot-cc start`: sync configuration, start the local credential shim, and start CCR.
- `cannbot-cc restart`: reconcile configuration and restart both managed services.
- `cannbot-cc stop`: stop only processes managed by this CLI.
- `cannbot-cc status`: report shim and CCR status.
- `cannbot-cc code [...args]`: sync, ensure services are ready, and launch Claude Code with all arguments passed through unchanged.
- `cannbot-cc doctor`: inspect runtime dependencies, credential sources, configuration, ports, proxy behavior, upstream reachability, and service health.

The first release does not implement the Anthropic/OpenAI protocol conversion itself, manage Cannbot accounts, persist Cannbot refresh tokens, expose a LAN service, or replace CCR's general provider management.

## Architecture

The request path is:

```text
Claude Code
  -> CCR on 127.0.0.1 (Anthropic Messages to OpenAI Chat Completions)
  -> credential shim on 127.0.0.1
  -> Cannbot compatible-mode gateway
```

CCR 2.0.0 uses the legacy `Providers` configuration schema and has no supported `extraHeaders` provider field. The credential shim therefore owns Cannbot-specific authentication while CCR continues to own protocol translation, streaming conversion, and tool-call conversion.

The shim accepts only requests carrying a generated local bearer secret. For each accepted request it reads the current Cannbot credentials, replaces the inbound authorization header with `Authorization: Bearer <accessToken>`, adds `x-api-vkey`, and forwards the request to:

```text
https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions
```

Request bodies are forwarded without semantic changes. Normal responses and server-sent event streams are returned without semantic changes so CCR remains responsible for OpenAI-to-Anthropic response conversion.

## Components

### CLI

The CLI parses commands, resolves cross-platform home-directory paths, runs dependency checks, and coordinates services. Child commands are spawned without a shell so arguments are not reinterpreted differently on Windows and POSIX systems.

### Credential reader

The credential reader obtains the access token from `~/.cannbot/session.json` and the virtual key from the Cannbot entries in OpenCode's authentication storage. It validates structure and presence but never prints credential values.

Credential files are read for every upstream attempt. A token changed by Cannbot is therefore used without regenerating CCR configuration.

### Credential shim

The shim is a loopback-only HTTP server. It verifies its local bearer secret, limits request body size, attaches Cannbot headers, forwards requests through the selected outbound proxy policy, and streams upstream responses with status and relevant headers preserved.

If Cannbot returns 401 or 403 before a response body is sent, the shim executes one bounded Cannbot credential-validation operation, reloads credentials, and retries once. Concurrent authentication failures share one refresh attempt. A second authentication failure is returned without another retry.

### CCR configuration reconciler

The reconciler reads `~/.claude-code-router/config.json`, validates that it is JSON, and updates only:

- the provider whose name is `cannbot`;
- `Router.default`, when the user explicitly selected Cannbot during `init` or supplied `--set-default`.

The managed provider uses CCR 2.0.0's schema:

```json
{
  "name": "cannbot",
  "api_base_url": "http://127.0.0.1:<shim-port>/v1/chat/completions",
  "api_key": "<generated-local-secret>",
  "models": ["glm-5.2"],
  "transformer": { "use": ["openai"] }
}
```

The openai transformer is the OpenAI-compatible transformer registered by CCR 2.0.0 and already used by providers in the current installation. The reconciler preserves property values it does not own, writes a temporary file in the same directory, flushes it, and atomically replaces the destination. Before the first managed change it creates a timestamped backup. It never places the Cannbot access token or virtual key in CCR configuration.

### Process manager

The process manager stores shim metadata under `~/.cannbot-cc-router/`, including PID, port, and a process-instance marker. Before stopping a PID, it verifies the marker so it cannot terminate an unrelated process that reused the same numeric PID.

CCR remains managed through its public `ccr start`, `ccr stop`, `ccr restart`, and `ccr status` commands. The CLI does not directly kill CCR processes.

## Configuration

Project-owned configuration is stored at `~/.cannbot-cc-router/config.json`. It contains only non-Cannbot secrets and preferences:

- selected model, initially `glm-5.2`;
- shim host fixed to `127.0.0.1`;
- shim port;
- generated local bearer secret;
- proxy mode;
- paths overridden by command-line options, when present.

The local bearer secret protects the loopback shim from unrelated local callers. The configuration directory and files receive owner-only permissions where the operating system supports them. Cannbot OAuth credentials remain in their existing Cannbot/OpenCode files.

## Proxy Behavior

Proxy mode accepts:

- `auto` (default): honor `HTTPS_PROXY`, `HTTP_PROXY`, and then `ALL_PROXY` for the Cannbot HTTPS request;
- `direct`: bypass all outbound proxies;
- an explicit HTTP, HTTPS, or SOCKS proxy URL.

The CLI merges `localhost` and `127.0.0.1` into both uppercase and lowercase `NO_PROXY` values inherited by CCR and Claude Code. This keeps Claude-to-CCR and CCR-to-shim traffic off Shadowsocks while allowing shim-to-Cannbot traffic to use Shadowsocks.

In the current environment, `HTTPS_PROXY=http://127.0.0.1:10808` is selected for Cannbot traffic and `NO_PROXY=localhost,127.0.0.1` bypasses it for local traffic. The invalid fallback `ALL_PROXY=http://127.0.0.1:9` does not override the protocol-specific HTTPS proxy.

The implementation does not silently fall back to direct internet access when an explicitly selected proxy is unavailable.

## Command Flows

### `init`

1. Check Node.js, Cannbot, CCR, and Claude Code.
2. Validate Cannbot credential files and query available models.
3. Select `glm-5.2` by default for this installation, or use `--model`/interactive selection.
4. Create project-owned configuration and a local bearer secret.
5. Back up and reconcile CCR configuration.
6. Run `doctor` without making a model request.

### `start`

1. Validate and reconcile configuration.
2. Start or reuse the matching shim instance.
3. Wait for the shim health endpoint.
4. Start CCR through `ccr start`.
5. Wait for CCR readiness and report both local endpoints.

### `code`

1. Perform the `start` readiness flow.
2. Launch `ccr code` with the remaining arguments unchanged.
3. Preserve stdin, stdout, stderr, signals, and the child exit code.

### Authentication retry

1. Buffer the bounded outbound request body so one retry is possible.
2. Load credentials and issue the Cannbot request.
3. On 401/403, run the bounded single-flight Cannbot validation command.
4. Reload credentials and retry once.
5. Stream the successful or final failed response back to CCR.

## Error Handling

Errors are categorized and include a concrete next action:

- missing Node.js or Node.js older than 20;
- missing `cannbot`, `ccr`, or `claude` executable;
- missing or malformed Cannbot/OpenCode credentials;
- expired login requiring `cannbot auth login`;
- malformed CCR configuration, which is never overwritten;
- occupied shim port, which is never resolved by terminating an unknown process;
- shim startup or health timeout;
- CCR startup or health timeout;
- Shadowsocks/proxy connection failure;
- Cannbot DNS, TLS, timeout, authentication, rate-limit, or upstream failure.

All logs pass through a redactor that removes bearer tokens, virtual keys, matching credential values, and sensitive query parameters. Debug logging may include paths, status codes, timing, model names, and sanitized headers, but not secrets.

## Testing

Unit tests cover:

- Windows, macOS, and Linux path resolution;
- Cannbot session and OpenCode authentication parsing;
- CCR configuration merge, backup, atomic-write behavior, and preservation of unrelated fields;
- log redaction;
- `NO_PROXY` merging and outbound proxy selection;
- command argument pass-through and exit-code propagation;
- PID marker validation.

Integration tests run a real shim against local mock servers and verify:

- the shim rejects a missing or incorrect local secret;
- the shim replaces authorization and injects `x-api-vkey`;
- credential files are reread between requests;
- a 401 response triggers exactly one shared refresh and one retry;
- a second authentication failure is not retried;
- JSON responses and SSE chunks are passed through correctly;
- proxy and direct modes choose the expected transport;
- no captured logs contain fixture secrets.

The real end-to-end acceptance test uses `cannbot/glm-5.2` and consumes a small amount of the Cannbot plan:

1. Run `init`, `doctor`, and `start`.
2. Send one minimal text request through Claude Code and assert a successful response.
3. Ask Claude Code to read a repository fixture using an allowed read-only tool and assert the expected fixture content appears.
4. Run `status` and confirm both shim and CCR are healthy.
5. Scan generated logs and configuration files for the live access token and virtual key; neither may appear outside their original credential stores.
6. Run `stop` and confirm the managed shim stops without affecting unrelated processes.

## Security and Operational Boundaries

- Both local services bind to loopback for this workflow.
- The shim requires a generated local bearer secret.
- Cannbot tokens are neither committed nor copied into project files or CCR configuration.
- The CLI does not display, export, or share Cannbot credentials.
- The user is responsible for confirming that their Cannbot subscription terms permit use through Claude Code.
- A failed proxy does not trigger an unapproved direct fallback.
- Configuration backups can contain pre-existing user secrets from CCR and therefore remain under the user's home configuration directory, never in the repository.

## Success Criteria

The work is complete when:

- the package installs and its help works on Node.js 20 or newer;
- automated unit and integration tests pass;
- existing CCR providers and non-owned router fields remain unchanged after initialization;
- CCR configuration contains no Cannbot token or virtual key;
- text streaming and a read-only Claude Code tool call succeed through `glm-5.2`;
- Shadowsocks is bypassed for loopback traffic and used for Cannbot HTTPS traffic in `auto` mode;
- logs and generated files do not leak Cannbot credentials;
- `start`, `status`, `code`, `restart`, and `stop` behave consistently on the current Windows environment, with path and process behavior covered for macOS and Linux.
