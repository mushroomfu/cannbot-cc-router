# Cannbot OpenCode Dual-Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror Cannbot CLI 1.0.1 authentication by reading both credentials from OpenCode `auth.json` while retaining zero dependency on `~/.cannbot/session.json`.

**Architecture:** `readCredentials()` returns `{ accessToken, virtualKey }` from `cannbot.access` and `cannbot-vk.key` in the first existing OpenCode authentication candidate. The shim strips hostile inbound authentication and sends `Authorization: Bearer <accessToken>` plus `x-api-vkey: <virtualKey>`, matching Cannbot CLI 1.0.1.

**Tech Stack:** TypeScript 6, Node.js 20+ ESM, Node test runner, Cannbot CLI 1.0.1, Claude Code CLI, CCR v3.0.3.

## Global Constraints

- Never read, create, migrate, or delete `~/.cannbot/session.json`.
- Read both credentials only from the first existing OpenCode `auth.json` candidate.
- Never copy either credential into project configuration, CCR configuration, Claude settings, logs, or diagnostics.
- Preserve the session-scoped Claude `apiKeyHelper`; do not inject `ANTHROPIC_AUTH_TOKEN`.
- Never modify global Claude settings or Codex `config.toml`.
- Preserve unrelated CCR providers, routes, and API keys.
- Retry only once after HTTP 401/403; do not retry HTTP 500 with alternate authentication.
- Do not touch the untracked repository directory `cannbot-cc-router/`.

---

This plan supersedes the remaining steps in `2026-07-13-cannbot-virtual-key-only-credentials.md`. Commit `9554406` remains useful because it removed the legacy session path; this plan corrects only the OpenCode credential contract and upstream headers.

### Task 1: Restore the OpenCode dual-credential contract

**Files:**
- Modify: `test/credentials.test.ts`
- Modify: `src/types.ts`
- Modify: `src/credentials.ts`
- Modify: `src/default-service.ts`
- Modify: `test/default-service.test.ts`
- Modify: `test/model-catalog.test.ts`
- Modify: `test/processes.test.ts`
- Modify: `test/shim-ccr-proxy.test.ts`
- Modify: `test/shim-control.test.ts`
- Modify: `test/shim-model-discovery.test.ts`
- Modify: `test/shim-retry.test.ts`
- Modify: `test/shim-security.test.ts`
- Modify: `test/shim.test.ts`

**Interfaces:**
- Consumes: OpenCode entries `cannbot.access` and `cannbot-vk.key`.
- Produces: `CannbotCredentials { accessToken: string; virtualKey: string }`.
- Errors: `AUTH_MISSING | AUTH_INVALID | ACCESS_TOKEN_MISSING | VIRTUAL_KEY_MISSING`.

- [ ] **Step 1: Write failing credential tests**

Change the successful Linux and Windows cases to write both entries and expect both values:

```ts
await writeJson(paths.openCodeAuthCandidates[0], {
  cannbot: { type: "oauth", access: "access-secret" },
  "cannbot-vk": { type: "api", key: "virtual-secret" }
});
assert.deepEqual(await readCredentials(paths), {
  accessToken: "access-secret",
  virtualKey: "virtual-secret"
});
```

Replace the OAuth-ignore test with:

```ts
test("requires a non-empty Cannbot access token", async () => {
  for (const cannbot of [undefined, { type: "oauth", access: "" }]) {
    const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
    await writeJson(paths.openCodeAuthCandidates[0], {
      ...(cannbot === undefined ? {} : { cannbot }),
      "cannbot-vk": { type: "api", key: "virtual-secret" }
    });
    await assert.rejects(readCredentials(paths), { code: "ACCESS_TOKEN_MISSING" });
  }
});
```

Keep the missing/malformed OpenCode cases and the separate empty virtual-key case.

- [ ] **Step 2: Verify RED**

```powershell
npm run build
node --test dist/test/credentials.test.js
```

Expected: build succeeds; successful cases fail because `readCredentials()` omits `accessToken`, and missing-access cases fail because the current reader accepts virtualKey-only auth.

- [ ] **Step 3: Implement the minimal credential contract**

Change `CannbotCredentials` to:

```ts
export interface CannbotCredentials {
  accessToken: string;
  virtualKey: string;
}
```

Add `ACCESS_TOKEN_MISSING` to `CredentialsErrorCode`. After parsing OpenCode authentication, read and validate the login access token:

```ts
const cannbotEntry = auth.cannbot;
const accessToken =
  cannbotEntry && typeof cannbotEntry === "object"
    ? (cannbotEntry as Record<string, unknown>).access
    : undefined;
if (typeof accessToken !== "string" || accessToken.trim() === "") {
  throw new CredentialsError(
    "ACCESS_TOKEN_MISSING",
    "Cannbot login access token is missing; run `cannbot connect`"
  );
}
```

Return `{ accessToken, virtualKey }`. Do not add a session path or session-file read. Change the managed-config leakage guard to check both fields. Update every listed fixture to return both fields; counter-based fixtures increment once and derive both values from that same read number.

- [ ] **Step 4: Verify GREEN and absence of session dependencies**

```powershell
npm run build
node --test dist/test/credentials.test.js dist/test/default-service.test.js dist/test/model-catalog.test.js
npm test
rg -n "cannbotSession|SESSION_MISSING|SESSION_INVALID" src test
git diff --check
```

Expected: focused and complete suites pass with at least 103 tests; `rg` and `git diff --check` print no output.

- [ ] **Step 5: Commit the credential contract**

```powershell
git add -- src/types.ts src/credentials.ts src/default-service.ts test/credentials.test.ts test/default-service.test.ts test/model-catalog.test.ts test/processes.test.ts test/shim-ccr-proxy.test.ts test/shim-control.test.ts test/shim-model-discovery.test.ts test/shim-retry.test.ts test/shim-security.test.ts test/shim.test.ts
git commit -m "fix: read Cannbot credentials from OpenCode auth"
```

### Task 2: Mirror Cannbot CLI 1.0.1 upstream headers

**Files:**
- Modify: `test/shim.test.ts`
- Modify: `test/shim-retry.test.ts`
- Modify: `test/shim-security.test.ts`
- Modify: `src/shim.ts`

**Interfaces:**
- Consumes: `CannbotCredentials { accessToken, virtualKey }`.
- Produces: `Authorization: Bearer <accessToken>` and `x-api-vkey: <virtualKey>`.

- [ ] **Step 1: Write failing shim header tests**

In `test/shim.test.ts`, keep hostile inbound values distinct from real credentials and assert the exact outgoing pair:

```ts
readCredentials: async () => ({
  accessToken: "access-secret",
  virtualKey: "virtual-secret"
})
```

```ts
const result = await post(shimAddress.port, "Bearer local-secret", body, {
  "x-api-key": "attacker-api-key",
  "x-api-vkey": "attacker-vkey"
});
assert.equal(captured[0].headers.authorization, "Bearer access-secret");
assert.equal(captured[0].headers["x-api-key"], undefined);
assert.equal(captured[0].headers["x-api-vkey"], "virtual-secret");
assert.doesNotMatch(JSON.stringify(captured[0].headers), /attacker/);
```

Extend retry/security captures so each request proves authorization and `x-api-vkey` come from the same credential read.

- [ ] **Step 2: Verify RED**

```powershell
npm run build
node --test dist/test/shim.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js
```

Expected: header assertions fail because the current shim sends virtualKey as Bearer and omits `x-api-vkey`.

- [ ] **Step 3: Implement the minimal header correction**

Change only `upstreamHeaders()`:

```ts
headers.authorization = `Bearer ${credentials.accessToken}`;
headers["x-api-vkey"] = credentials.virtualKey;
headers["content-length"] = String(body.byteLength);
```

Retain inbound-header stripping, 401/403 single-flight refresh, and no HTTP 500 retry.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
npm run build
node --test dist/test/shim.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js
npm test
git diff --check
```

Expected: focused tests and at least 103 complete tests pass.

```powershell
git add -- src/shim.ts test/shim.test.ts test/shim-retry.test.ts test/shim-security.test.ts
git commit -m "fix: mirror Cannbot CLI upstream authentication"
```

### Task 3: Document, package, install, and verify lifecycle

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Correct credential documentation**

State that the router rereads `cannbot.access` and `cannbot-vk.key` from OpenCode `auth.json`, sends the former as Bearer and the latter as `x-api-vkey`, never reads the legacy session file, and never copies either value into managed configuration.

- [ ] **Step 2: Run automated/package verification**

```powershell
npm test
npm pack --dry-run
git diff --check
npm run build
npm install -g .
Test-Path "$env:APPDATA\npm\node_modules\cannbot-cc-router\dist\src\cli.js"
```

Expected: at least 103 tests pass; the package includes credentials, Claude launcher, and shim outputs; global CLI path exists.

- [ ] **Step 3: Verify CCR 3.0.3 lifecycle without a model request**

```powershell
cannbot-cc stop
cannbot-cc init --model glm-5.2 --proxy auto --set-default
cannbot-cc restart --set-default
cannbot-cc doctor --json
cannbot-cc status --json
cannbot-cc stop
cannbot-cc status --json
```

Expected: doctor is `ok:true`, CCR 3.0.3 is supported, running status is true/true, and final status is false/false.

- [ ] **Step 4: Obtain renewed authorization before live E2E**

The previous one-time E2E authorization was consumed by the virtual-key-only failure. Do not run another Claude/model request until the user explicitly authorizes one additional invocation of:

```powershell
cannbot-cc code --context 1m -p "Reply with exactly OK" --output-format text
```

Use the existing settings-hash, warning scan, temporary-directory comparison, and `finally { cannbot-cc stop }` guard. Expected: exact `OK`, no dual-auth warning, no `All target providers failed`, unchanged global Claude settings, no temporary directory, stopped services.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: describe Cannbot OpenCode authentication"
```

### Task 4: Finish the development branch

- [ ] **Step 1: Run fresh completion verification**

```powershell
npm test
git diff --check
git status --short --branch
```

Expected: at least 103 tests pass; no tracked changes remain; the only untracked entry is `cannbot-cc-router/`.

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`**

Present the merge, PR, keep, and typed-confirmation discard choices without acting until the user selects one.
