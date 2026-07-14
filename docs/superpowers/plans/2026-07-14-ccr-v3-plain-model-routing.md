# CCR v3 Plain-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code requests route successfully through CCR 3.0.3 by forwarding discovered Cannbot models as plain model identifiers.

**Architecture:** The shim remains the single Claude/Cannbot boundary. For Anthropic namespaced model IDs it validates discovery membership, removes `[1m]`, and forwards the plain model to CCR; CCR's managed Router/provider catalog selects Cannbot. Authentication and lifecycle behavior remain unchanged.

**Tech Stack:** TypeScript 6, Node.js 20+ ESM, Node test runner, Claude Code CLI, CCR v2 and v3.0.3.

## Global Constraints

- Never read, create, migrate, or delete `~/.cannbot/session.json`.
- Never modify global Claude settings or Codex `config.toml`.
- Preserve the temporary session-scoped Claude `apiKeyHelper` and do not inject `ANTHROPIC_AUTH_TOKEN`.
- Preserve Cannbot authentication as `Authorization: Bearer <accessToken>` plus `x-api-vkey: <virtualKey>` from OpenCode `auth.json`.
- Preserve unknown-model rejection, `[1m]` handling, streaming, and `/v1/messages/count_tokens` proxying.
- Preserve unrelated CCR providers, routes, and API keys.
- Do not touch the untracked `cannbot-cc-router/` directory.

---

### Task 1: Forward plain model identifiers to CCR

**Files:**
- Modify: `test/shim-ccr-proxy.test.ts:82`
- Modify: `src/shim.ts:188`

**Interfaces:**
- Consumes: Claude model IDs `anthropic/cannbot/<model>` and `anthropic/cannbot/<model>[1m]`.
- Produces: CCR request JSON with `model: "<model>"` after discovery validation.

- [ ] **Step 1: Write failing integration assertions**

In `test/shim-ccr-proxy.test.ts`, change the two captured CCR body expectations:

```ts
assert.deepEqual(JSON.parse(captured[0].body), {
  model: "glm-5.2",
  messages: [{ role: "user", content: "hello" }]
});
```

```ts
assert.deepEqual(JSON.parse(captured[0].body), {
  model: "glm-5.2",
  messages: []
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npm run build
node --test dist/test/shim-ccr-proxy.test.js
```

Expected: the two assertions fail because the current shim forwards `cannbot,glm-5.2`.

- [ ] **Step 3: Implement the minimal rewrite correction**

In `rewriteClaudeModel()` in `src/shim.ts`, replace only the assignment after model validation:

```ts
requestBody.model = model;
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```powershell
npm run build
node --test dist/test/shim-ccr-proxy.test.js dist/test/shim.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js
```

Expected: all focused tests pass, including plain model rewriting, `[1m]`, streaming, local authentication, and dual upstream credentials.

- [ ] **Step 5: Run complete automated verification**

Run:

```powershell
npm test
npm pack --dry-run
git diff --check
```

Expected: at least 103 tests pass, package output includes `dist/src/shim.js` and `dist/src/claude-launcher.js`, and `git diff --check` prints no output.

- [ ] **Step 6: Commit the routing fix**

```powershell
git add -- src/shim.ts test/shim-ccr-proxy.test.ts docs/superpowers/specs/2026-07-14-ccr-v3-plain-model-routing-design.md docs/superpowers/plans/2026-07-14-ccr-v3-plain-model-routing.md
git commit -m "fix: route Cannbot models through CCR v3"
```

### Task 2: Install and verify runtime behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the plain-model shim build and existing dual-auth documentation change.
- Produces: a globally installed CLI verified against CCR 3.0.3 and Claude Code.

- [ ] **Step 1: Document the model-routing boundary**

Add a concise security/architecture note stating that Claude's `anthropic/cannbot/<model>` ID is validated and forwarded to CCR as the plain discovered model ID, while CCR's managed route selects the Cannbot provider.

- [ ] **Step 2: Rebuild and reinstall globally**

```powershell
npm run build
npm install -g .
Test-Path "$env:APPDATA\npm\node_modules\cannbot-cc-router\dist\src\cli.js"
```

Expected: every command exits 0 and the installed CLI path exists.

- [ ] **Step 3: Verify CCR lifecycle without inference**

```powershell
cannbot-cc restart --set-default
cannbot-cc doctor --json
cannbot-cc status --json
cannbot-cc stop
cannbot-cc status --json
```

Expected: doctor reports `ok:true`, running status is true/true, and final status is false/false.

- [ ] **Step 4: Perform an explicitly authorized end-to-end request**

With global Claude settings hash and launcher temporary-directory inventory captured before the call, run:

```powershell
cannbot-cc code --context 1m -p "Reply with exactly OK" --output-format text
```

Use `finally { cannbot-cc stop }`. Expected: an exact `OK` line, no dual-authentication warning, no `All target providers failed`, unchanged global Claude settings, no leaked temporary directory, and final false/false service status.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: describe CCR plain-model routing"
```

### Task 3: Finish the development branch

**Files:**
- No file changes.

**Interfaces:**
- Consumes: committed implementation and verification evidence.
- Produces: a user-selected merge, PR, keep, or discard outcome.

- [ ] **Step 1: Run fresh completion verification**

```powershell
npm test
git diff --check
git status --short --branch
```

Expected: at least 103 tests pass, no tracked changes remain, and the only untracked entry is `cannbot-cc-router/`.

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`**

Present the merge, PR, keep, and typed-confirmation discard choices without acting until the user selects one.
