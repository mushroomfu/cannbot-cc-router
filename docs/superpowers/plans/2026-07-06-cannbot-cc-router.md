# Cannbot CC Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform Node.js CLI that lets Claude Code use `cannbot/glm-5.2` through CCR while dynamically injecting Cannbot credentials in a loopback-only shim.

**Architecture:** CCR continues to translate Anthropic Messages to OpenAI Chat Completions. A small local HTTP shim authenticates CCR with a generated local secret, rereads Cannbot credentials for every upstream attempt, injects Cannbot's two authentication headers, honors the selected outbound proxy, and streams the response back unchanged. The CLI owns configuration reconciliation, shim lifecycle, CCR orchestration, diagnostics, and Claude Code argument pass-through.

**Tech Stack:** Node.js 20+, TypeScript ESM, Node test runner, Commander, native HTTP/HTTPS streams, `proxy-from-env`, `https-proxy-agent`, and `socks-proxy-agent`.

---

## File Map

- `package.json`: package metadata, binary entry point, scripts, runtime dependencies, and Node engine requirement.
- `tsconfig.json`: strict ESM compilation for source and tests.
- `.gitignore`: generated output, coverage, logs, and local environment files.
- `src/types.ts`: shared configuration and credential contracts.
- `src/paths.ts`: cross-platform home/config path resolution and executable lookup inputs.
- `src/redact.ts`: secret-aware log redaction.
- `src/credentials.ts`: Cannbot/OpenCode credential loading and bounded login validation.
- `src/file-store.ts`: JSON reads, owner-only writes, backup, and atomic replacement.
- `src/ccr-config.ts`: legacy CCR 2.0 provider merge and default-route reconciliation.
- `src/proxy.ts`: proxy selection, `NO_PROXY` merge, and HTTP/SOCKS agent creation.
- `src/shim.ts`: authenticated loopback proxy, retry, response streaming, health, and shutdown.
- `src/shim-main.ts`: detached shim process entry point.
- `src/processes.ts`: executable checks, child process execution, shim lifecycle, and CCR orchestration.
- `src/doctor.ts`: structured diagnostic checks.
- `src/cli.ts`: command definitions and user-facing output.
- `test/*.test.ts`: unit tests colocated by responsibility.
- `test/fixtures/tool-read.txt`: deterministic fixture for the real read-only Claude Code acceptance test.
- `README.md`: installation, commands, proxy behavior, security boundaries, and recovery instructions.

## Task 1: Scaffold the TypeScript CLI

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `test/cli-help.test.ts`

- [ ] **Step 1: Create package metadata and install dependencies**

Create `package.json` with this public contract, then use `npm install` so npm records current compatible versions in `package-lock.json`:

```json
{
  "name": "cannbot-cc-router",
  "version": "0.1.0",
  "description": "Use Cannbot models from Claude Code through CCR",
  "type": "module",
  "bin": { "cannbot-cc": "dist/src/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "test": "npm run clean && npm run build && node --test dist/test/*.test.js",
    "check": "npm run test"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "commander": "latest",
    "https-proxy-agent": "latest",
    "proxy-from-env": "latest",
    "socks-proxy-agent": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  }
}
```

Run:

```powershell
npm install
```

Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 2: Configure strict compilation**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write the failing help test**

```ts
// test/cli-help.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildProgram } from "../src/cli.js";

test("help exposes the complete command surface", () => {
  const names = buildProgram().commands.map((command) => command.name());
  assert.deepEqual(names, [
    "init", "sync", "start", "restart", "stop", "status", "code", "doctor"
  ]);
});
```

- [ ] **Step 4: Run the test and verify RED**

Run: `npm test`

Expected: compilation fails because `buildProgram` is not implemented.

- [ ] **Step 5: Implement the minimal command surface**

Export `buildProgram()` from `src/cli.ts`, create the eight commands in the tested order, add the Node shebang, and parse arguments only when `src/cli.ts` is the executed module. Each handler initially delegates to an injected `CommandHandlers` object so later tests can exercise the command layer without touching the user's home directory.

```ts
export interface CommandHandlers {
  init(options: unknown): Promise<number>;
  sync(options: unknown): Promise<number>;
  start(options: unknown): Promise<number>;
  restart(options: unknown): Promise<number>;
  stop(options: unknown): Promise<number>;
  status(options: unknown): Promise<number>;
  code(args: string[], options: unknown): Promise<number>;
  doctor(options: unknown): Promise<number>;
}

export function buildProgram(handlers: CommandHandlers = unavailableHandlers): Command {
  const program = new Command().name("cannbot-cc");
  for (const name of ["init", "sync", "start", "restart", "stop", "status", "doctor"])
    program.command(name).action(async (options) => process.exitCode = await handlers[name](options));
  program.command("code [args...]").allowUnknownOption(true)
    .action(async (args, options) => process.exitCode = await handlers.code(args, options));
  return program;
}
```

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test`

Expected: one passing test.

```powershell
git add package.json package-lock.json tsconfig.json .gitignore src/cli.ts test/cli-help.test.ts
git commit -m "chore: scaffold cannbot cc cli"
```

## Task 2: Resolve Paths, Read Credentials, and Redact Secrets

**Files:**
- Create: `src/types.ts`
- Create: `src/paths.ts`
- Create: `src/credentials.ts`
- Create: `src/redact.ts`
- Create: `test/credentials.test.ts`
- Create: `test/redact.test.ts`

- [ ] **Step 1: Write credential and redaction tests**

Tests create an isolated temporary home and assert:

```ts
const paths = resolvePaths({ home: tempHome });
await writeJson(paths.cannbotSession, { accessToken: "access-secret" });
await writeJson(paths.openCodeAuthCandidates[0], {
  cannbot: { type: "oauth", access: "oauth-access", refresh: "refresh-secret" },
  "cannbot-vk": { type: "api", key: "virtual-secret" }
});
assert.deepEqual(await readCredentials(paths), {
  accessToken: "access-secret",
  virtualKey: "virtual-secret"
});
assert.equal(
  redact("Authorization: Bearer access-secret x-api-vkey=virtual-secret", ["access-secret", "virtual-secret"]),
  "Authorization: Bearer [REDACTED] x-api-vkey=[REDACTED]"
);
```

Also assert clear typed errors for missing session, malformed JSON, missing access token, and missing virtual key. Test both `~/.local/share/opencode/auth.json` and platform-specific candidate paths.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run build`

Expected: compilation fails because the imported modules do not exist.

- [ ] **Step 3: Implement shared contracts and path resolution**

Define:

```ts
export interface CannbotCredentials { accessToken: string; virtualKey: string }
export interface ResolvedPaths {
  home: string;
  projectDir: string;
  projectConfig: string;
  shimState: string;
  ccrConfig: string;
  cannbotSession: string;
  openCodeAuthCandidates: string[];
}
```

`resolvePaths()` uses `os.homedir()` by default, accepts overrides for tests and CLI flags, and never performs I/O.

- [ ] **Step 4: Implement strict credential parsing and redaction**

`readCredentials()` reads UTF-8 JSON, requires non-empty strings at `session.accessToken` and `auth["cannbot-vk"].key`, and returns values without caching. `redact()` replaces known secret values, bearer values, `x-api-vkey` header values, and sensitive JSON fields while preserving useful context.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all credential and redaction tests pass, and fixture secrets do not appear in failure output.

```powershell
git add src/types.ts src/paths.ts src/credentials.ts src/redact.ts test/credentials.test.ts test/redact.test.ts
git commit -m "feat: load and redact Cannbot credentials"
```

## Task 3: Persist Project State and Reconcile CCR Configuration

**Files:**
- Create: `src/file-store.ts`
- Create: `src/ccr-config.ts`
- Create: `test/file-store.test.ts`
- Create: `test/ccr-config.test.ts`

- [ ] **Step 1: Write failing merge and atomic-write tests**

Use a fixture with three unrelated providers and all router fields. Assert that reconciliation:

```ts
const merged = reconcileCcrConfig(existing, {
  shimPort: 8787,
  localSecret: "local-only",
  model: "glm-5.2",
  setDefault: true
});
assert.equal(merged.Providers.length, 4);
assert.deepEqual(merged.Providers.find((p) => p.name === "cannbot"), {
  name: "cannbot",
  api_base_url: "http://127.0.0.1:8787/v1/chat/completions",
  api_key: "local-only",
  models: ["glm-5.2"],
  transformer: { use: ["openai"] }
});
assert.equal(merged.Router.default, "cannbot,glm-5.2");
assert.equal(merged.Router.think, existing.Router.think);
```

Reconcile twice and assert idempotency. Verify malformed CCR JSON is untouched. Verify the first write creates one timestamped backup and subsequent writes do not create another first-change backup marker.

- [ ] **Step 2: Verify RED**

Run: `npm run build`

Expected: missing `file-store` and `ccr-config` modules.

- [ ] **Step 3: Implement atomic JSON storage**

Implement `readJsonFile`, `writeJsonAtomic`, and `backupOnce`. Write the temporary file in the destination directory, set mode `0o600`, sync and close it, rename it over the destination, and remove the temporary file on failure. Backups stay beside the user's CCR config and use `config.json.backup-YYYYMMDD-HHmmss`.

- [ ] **Step 4: Implement the owned-field merge**

`reconcileCcrConfig` removes only prior providers named `cannbot`, appends the exact managed provider, preserves every other top-level field, and changes only `Router.default` when `setDefault` is true. Reject non-object configs, non-array `Providers`, and non-object `Router`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: atomic-write, backup, preservation, and idempotency tests pass.

```powershell
git add src/file-store.ts src/ccr-config.ts test/file-store.test.ts test/ccr-config.test.ts
git commit -m "feat: reconcile managed CCR provider"
```

## Task 4: Select the Outbound Proxy Safely

**Files:**
- Create: `src/proxy.ts`
- Create: `test/proxy.test.ts`

- [ ] **Step 1: Write failing proxy-policy tests**

Cover the approved environment and precedence:

```ts
const CANNBOT_URL = "https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions";
const env = {
  HTTPS_PROXY: "http://127.0.0.1:10808",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1"
};
assert.equal(selectProxy(CANNBOT_URL, "auto", env), "http://127.0.0.1:10808");
assert.equal(selectProxy("http://127.0.0.1:8787/health", "auto", env), "");
assert.equal(selectProxy(CANNBOT_URL, "direct", env), "");
assert.equal(mergeNoProxy("example.com"), "example.com,localhost,127.0.0.1");
```

Also test explicit HTTP, HTTPS, SOCKS4, and SOCKS5 URLs and rejection of unsupported protocols.

- [ ] **Step 2: Verify RED**

Run: `npm run build`

Expected: missing proxy module.

- [ ] **Step 3: Implement selection and agent creation**

`selectProxy()` temporarily evaluates a supplied environment through `proxy-from-env` without mutating `process.env`. `createProxyAgent()` returns `HttpsProxyAgent` for HTTP(S), `SocksProxyAgent` for SOCKS, and `undefined` for direct. `childProxyEnv()` copies the current environment and merges loopback into uppercase and lowercase `NO_PROXY`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test`

Expected: all proxy-policy tests pass.

```powershell
git add src/proxy.ts test/proxy.test.ts
git commit -m "feat: support safe outbound proxy policy"
```

## Task 5: Build the Credential Shim

**Files:**
- Create: `src/shim.ts`
- Create: `test/shim.test.ts`

- [ ] **Step 1: Write a failing authenticated-forwarding test**

Start a local mock upstream and shim on ephemeral ports. Send a request with the local secret and assert the mock receives the exact JSON body plus:

```ts
assert.equal(received.headers.authorization, "Bearer access-secret");
assert.equal(received.headers["x-api-vkey"], "virtual-secret");
assert.equal(received.headers.host, upstreamHost);
```

Send the wrong local secret and assert 401 without any upstream request.

- [ ] **Step 2: Verify RED**

Run: `npm run build`

Expected: missing shim module.

- [ ] **Step 3: Implement minimal authenticated forwarding**

Export `createShim(options)` returning `{ listen, close, address, instanceId }`. Accept only `POST /v1/chat/completions`, `GET /health`, and authenticated `POST /shutdown`. Reject bodies over 10 MiB. Remove hop-by-hop and inbound authentication headers, reread credentials, inject Cannbot headers, choose the proxy agent, and issue an HTTP(S) request to the configured upstream URL.

- [ ] **Step 4: Write failing retry, refresh-concurrency, and SSE tests**

Test an upstream sequence of 401 then 200 and assert exactly two requests and one refresh call. Send two simultaneous failing requests and assert one shared refresh operation. Return 401 twice and assert no third request. Stream three SSE chunks with delays and assert the client receives the same ordered bytes before connection close.

- [ ] **Step 5: Verify the new tests fail for missing behavior**

Run: `npm test`

Expected: forwarding tests pass while retry and single-flight tests fail.

- [ ] **Step 6: Implement one bounded single-flight retry and streaming**

Keep the buffered request body for one replay. On 401/403, drain the first response, await a shared `refreshPromise`, clear it in `finally`, reread credentials, and retry once. Pipe the final `IncomingMessage` directly to the client after copying status and end-to-end headers. Abort the upstream request when the downstream disconnects.

- [ ] **Step 7: Verify GREEN and commit**

Run: `npm test`

Expected: authentication, header replacement, reread, retry, concurrency, JSON, SSE, body limit, and shutdown tests all pass.

```powershell
git add src/shim.ts test/shim.test.ts
git commit -m "feat: add dynamic Cannbot credential shim"
```

## Task 6: Manage the Shim, CCR, and Claude Code Processes

**Files:**
- Create: `src/shim-main.ts`
- Create: `src/processes.ts`
- Create: `test/processes.test.ts`

- [ ] **Step 1: Write failing process behavior tests**

Use temporary executable fixtures and dependency injection around `spawn`. Assert:

- attached execution preserves argument boundaries, stdio mode, signals, and exit code;
- detached shim launch uses `process.execPath`, the compiled shim entry, and no shell;
- health polling accepts only the configured instance ID;
- stop calls the authenticated shutdown endpoint and does not kill a numeric PID directly;
- CCR operations call only `ccr start|stop|restart|status`;
- `code` calls `ccr code` followed by unchanged user arguments.

- [ ] **Step 2: Verify RED**

Run: `npm run build`

Expected: missing process modules.

- [ ] **Step 3: Implement the shim entry and lifecycle**

`shim-main.ts` reads project configuration, creates the shim, writes state only after listening, and removes its state on clean shutdown. `ensureShim()` reuses a healthy matching instance or launches a detached child and polls `/health` with a bounded timeout. `stopShim()` authenticates `/shutdown` with both local secret and instance ID.

- [ ] **Step 4: Implement CCR and Claude orchestration**

Provide `checkExecutable`, `runCaptured`, `runAttached`, `startCcr`, `stopCcr`, `restartCcr`, and `runCcrCode`. Use `shell: false`, merge loopback `NO_PROXY`, redact captured errors, and propagate exit codes.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all process tests pass on Windows without shell quoting and platform branches are covered with injected platform values.

```powershell
git add src/shim-main.ts src/processes.ts test/processes.test.ts
git commit -m "feat: orchestrate shim CCR and Claude Code"
```

## Task 7: Implement Commands and Diagnostics

**Files:**
- Create: `src/doctor.ts`
- Modify: `src/cli.ts`
- Create: `test/doctor.test.ts`
- Create: `test/commands.test.ts`

- [ ] **Step 1: Write failing doctor and command-flow tests**

Inject file, process, and network adapters. Assert `doctor` reports separate checks for Node, Cannbot, CCR, Claude, session, virtual key, CCR config, shim port, proxy, Cannbot reachability, shim health, and CCR status. Assert exit code 1 when a required check fails and no report contains secrets.

Assert command ordering:

```ts
assert.deepEqual(await traceCommand("start"), [
  "load-project-config", "validate-credentials", "backup-ccr-once",
  "reconcile-ccr", "ensure-shim", "start-ccr", "wait-ccr"
]);
assert.deepEqual(await traceCommand("code", ["-p", "hello world"]), [
  "sync", "start", "ccr-code:-p", "ccr-code:hello world"
]);
```

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing doctor and real handlers.

- [ ] **Step 3: Implement project configuration and command handlers**

Add typed options:

```text
init --model <id> --proxy <auto|direct|URL> --shim-port <port> --set-default
sync --set-default
start
restart
stop
status --json
code [args...]
doctor --json
```

Default `init` model to `glm-5.2`, validate it against `cannbot models cannbot`, generate a 32-byte base64url local secret, and prompt only when stdin is interactive and no model is supplied. `sync` validates credentials before touching CCR. `start` follows the tested order. `code` performs readiness then delegates to `ccr code` with exact arguments.

- [ ] **Step 4: Implement diagnostics**

Represent each check as `{ name, status, detail, action? }`. Human output uses one line per check; JSON output is stable and contains no secret fields. Proxy diagnostics test the configured proxy endpoint separately from the Cannbot reachability command so failures identify the correct segment.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test`

Expected: all command-flow and diagnostic tests pass.

```powershell
git add src/doctor.ts src/cli.ts test/doctor.test.ts test/commands.test.ts
git commit -m "feat: expose Cannbot router commands and doctor"
```

## Task 8: Document, Package, and Run Real Acceptance Tests

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `test/fixtures/tool-read.txt`
- Modify: `package.json`

- [ ] **Step 1: Add the deterministic tool fixture**

Create `test/fixtures/tool-read.txt` with exactly:

```text
CANNBOT_CC_ROUTER_TOOL_OK
```

- [ ] **Step 2: Write operator documentation**

Document prerequisites, installation, every command, `glm-5.2`, Shadowsocks `auto` behavior, `--proxy direct`, credential locations without values, backup naming, loopback security, `cannbot auth login` recovery, and `stop` behavior. Include PowerShell, bash, and zsh examples.

- [ ] **Step 3: Run the complete automated verification**

Run:

```powershell
npm run check
npm pack --dry-run
```

Expected: all tests pass; the package contains `dist`, `README.md`, `LICENSE`, and package metadata, but no test secrets, logs, home configuration, or live credentials.

- [ ] **Step 4: Initialize the live user configuration**

Run:

```powershell
node dist/src/cli.js init --model glm-5.2 --proxy auto --set-default
node dist/src/cli.js doctor
node dist/src/cli.js start
node dist/src/cli.js status --json
```

Expected: doctor succeeds, shim and CCR report healthy, the shim binds only to `127.0.0.1`, and CCR contains the managed provider while preserving the three existing providers.

- [ ] **Step 5: Verify a real text response**

Run:

```powershell
node dist/src/cli.js code -p "Reply with exactly CANNBOT_CC_ROUTER_TEXT_OK" --output-format text
```

Expected: successful exit and output containing `CANNBOT_CC_ROUTER_TEXT_OK`.

- [ ] **Step 6: Verify a real read-only tool call**

Run:

```powershell
node dist/src/cli.js code -p "Use the Read tool to read test/fixtures/tool-read.txt, then reply with its exact content." --allowedTools Read --output-format text
```

Expected: successful exit and output containing `CANNBOT_CC_ROUTER_TOOL_OK`.

- [ ] **Step 7: Verify no live credential leakage**

Load the live access token and virtual key into memory, scan the repository, project-owned configuration, CCR configuration, and generated logs, and print only `SECRET_SCAN_OK` or `SECRET_SCAN_FAILED`. Do not print either secret. Expected: `SECRET_SCAN_OK`.

- [ ] **Step 8: Stop services and verify clean shutdown**

Run:

```powershell
node dist/src/cli.js stop
node dist/src/cli.js status --json
```

Expected: the managed shim is stopped, CCR stop is reported, and no unrelated process is terminated.

- [ ] **Step 9: Commit documentation and acceptance fixture**

```powershell
git add README.md LICENSE test/fixtures/tool-read.txt package.json package-lock.json
git commit -m "docs: add installation and operations guide"
```

## Final Verification

- [ ] Run `npm run check` fresh and confirm zero failures.
- [ ] Run `npm pack --dry-run` and inspect the complete file list.
- [ ] Run `git diff --check` and `git status --short`.
- [ ] Compare every success criterion in the approved design to test or command evidence.
- [ ] Confirm the live CCR config backup exists and unrelated provider/router values are preserved.
- [ ] Confirm the repository, CCR config, project config, and logs do not contain live Cannbot credentials.
- [ ] Record the real text, tool-call, proxy path, and shutdown results without including secrets.
