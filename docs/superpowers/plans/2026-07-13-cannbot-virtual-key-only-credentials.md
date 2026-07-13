# Cannbot Virtual-Key-Only Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the router's legacy `~/.cannbot/session.json` and Cannbot login access-token dependency so a normal Cannbot CLI 1.0.1 `cannbot connect` is sufficient for CCR and Claude Code routing.

**Architecture:** `readCredentials()` reads only `cannbot-vk.key` from the first existing OpenCode `auth.json` candidate and returns `CannbotCredentials { virtualKey: string }`. Types, path resolution, doctor guidance, configuration leak checks, and test fixtures are narrowed to that actual provider credential; Cannbot login and model availability remain validated by the bounded `cannbot models cannbot` command.

**Tech Stack:** TypeScript 6, Node.js 20+ ESM, Node test runner, Cannbot CLI 1.0.1, Claude Code CLI, CCR v2 and v3.0.x.

## Global Constraints

- Preserve user, project, and local Claude permissions, hooks, plugins, MCP configuration, and setting-source precedence.
- Never rewrite `~/.claude/settings.json`, Codex `config.toml`, or unrelated CCR providers and routes.
- Never read, return, copy, migrate, create, or delete `~/.cannbot/session.json` or `cannbot.access`.
- Read only `cannbot-vk.key` from the existing OpenCode authentication candidates.
- Keep existing generic secret redaction, including access-token-shaped fields.
- Support Windows, Linux, and macOS; CCR support remains v2 and the complete v3.0.x series.
- Do not retry HTTP 500 responses with an alternate authentication method.
- Retain the existing single-flight credential refresh only for HTTP 401 and 403.
- Do not touch the untracked repository directory `cannbot-cc-router/`.

## Completed Prerequisites - Do Not Repeat

- `9b55c43 fix: isolate Claude gateway authentication`
- `f1804f8 fix: authenticate Cannbot with virtual key`
- `41324e5 docs: document authentication boundaries`
- `2f155cc docs: remove legacy Cannbot session dependency`

---
This plan supersedes the uncompleted execution and verification steps in `docs/superpowers/plans/2026-07-13-claude-cannbot-auth-fix.md`; that file remains the history for the completed prerequisite commits.


### Task 1: Remove the legacy session and access-token credential boundary

**Files:**
- Modify: `test/credentials.test.ts:19-75`
- Modify: `test/doctor.test.ts:20-68`
- Modify: `src/types.ts:1-16`
- Modify: `src/paths.ts:15-58`
- Modify: `src/credentials.ts:5-107`
- Modify: `src/doctor.ts:74-79`
- Modify: `src/default-service.ts:245-255`
- Modify: `test/default-service.test.ts:22-110`
- Modify: `test/model-catalog.test.ts:51-60`
- Modify: `test/processes.test.ts:48-130`
- Modify: `test/shim-ccr-proxy.test.ts:74-78`
- Modify: `test/shim-control.test.ts:60-111`
- Modify: `test/shim-model-discovery.test.ts:36-61`
- Modify: `test/shim-retry.test.ts:61-165`
- Modify: `test/shim-security.test.ts:55-59`
- Modify: `test/shim.test.ts:80-121`

**Interfaces:**
- Consumes: `ResolvedPaths.openCodeAuthCandidates: string[]` and OpenCode JSON entry `"cannbot-vk": { key: string }`.
- Produces: `CannbotCredentials { virtualKey: string }` and errors `AUTH_MISSING | AUTH_INVALID | VIRTUAL_KEY_MISSING`.
- Preserves: `refreshCannbotCredentials()` calling `cannbot models cannbot` and shim 401/403 retry rereading `virtualKey`.

- [ ] **Step 1: Rewrite credential and doctor tests for the virtual-key-only contract**

Replace the session-oriented cases in `test/credentials.test.ts` with these cases while retaining the Windows candidate test:

```ts
test("reads the virtual key without a Cannbot session", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await writeJson(paths.openCodeAuthCandidates[0], {
    "cannbot-vk": { type: "api", key: "virtual-secret" }
  });

  assert.deepEqual(await readCredentials(paths), {
    virtualKey: "virtual-secret"
  });
});

test("ignores Cannbot OAuth access state", async () => {
  for (const cannbot of [
    undefined,
    { type: "oauth", access: "", refresh: "" },
    { type: "oauth", access: "oauth-access", refresh: "refresh-secret" }
  ]) {
    const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
    await writeJson(paths.openCodeAuthCandidates[0], {
      ...(cannbot === undefined ? {} : { cannbot }),
      "cannbot-vk": { type: "api", key: "virtual-secret" }
    });
    assert.deepEqual(await readCredentials(paths), { virtualKey: "virtual-secret" });
  }
});

test("reports missing OpenCode authentication", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await assert.rejects(readCredentials(paths), { code: "AUTH_MISSING" });
});

test("reports malformed OpenCode authentication without exposing content", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await mkdir(dirname(paths.openCodeAuthCandidates[0]), { recursive: true });
  await writeFile(paths.openCodeAuthCandidates[0], "{not-json access-secret", "utf8");

  await assert.rejects(readCredentials(paths), (error: unknown) => {
    assert.ok(error instanceof CredentialsError);
    assert.equal(error.code, "AUTH_INVALID");
    assert.doesNotMatch(error.message, /access-secret/);
    return true;
  });
});

test("requires a non-empty virtual key", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await writeJson(paths.openCodeAuthCandidates[0], { "cannbot-vk": { key: "" } });
  await assert.rejects(readCredentials(paths), { code: "VIRTUAL_KEY_MISSING" });
});
```

The Windows test must write only the OpenCode candidate:

```ts
await writeJson(paths.openCodeAuthCandidates.at(-1)!, {
  "cannbot-vk": { key: "virtual-secret" }
});
assert.deepEqual(await readCredentials(paths), { virtualKey: "virtual-secret" });
```

Add to `test/doctor.test.ts`:

```ts
test("credential failures direct users to cannbot connect", async () => {
  const report = await runDoctor(healthyDependencies({
    credentials: async () => { throw new Error("missing virtual key"); }
  }));
  assert.deepEqual(
    report.checks.find((check) => check.name === "credentials"),
    {
      name: "credentials",
      status: "fail",
      detail: "check failed",
      action: "Run `cannbot connect`"
    }
  );
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```powershell
npm run build
node --test dist/test/credentials.test.js dist/test/doctor.test.js
```

Expected: build succeeds; credential tests fail with the old `SESSION_MISSING` behavior and the doctor test fails because its action still mentions `cannbot auth login`.

- [ ] **Step 3: Implement the virtual-key-only types, paths, reader, and diagnostics**

Change `src/types.ts` to:

```ts
export interface CannbotCredentials {
  virtualKey: string;
}

export interface ResolvedPaths {
  home: string;
  projectDir: string;
  projectConfig: string;
  shimState: string;
  ccrConfig: string;
  ccrV2Config: string;
  ccrV3ConfigDb: string;
  ccrV3ApiKeysDb: string;
  openCodeAuthCandidates: string[];
}
```

Remove this property from the object returned by `resolvePaths()` in `src/paths.ts`:

```ts
cannbotSession: join(home, ".cannbot", "session.json"),
```

Narrow the error union and replace `readCredentials()` in `src/credentials.ts`:

```ts
export type CredentialsErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "VIRTUAL_KEY_MISSING";

export async function readCredentials(
  paths: ResolvedPaths
): Promise<CannbotCredentials> {
  const authPath = await firstExisting(paths.openCodeAuthCandidates);
  if (!authPath) {
    throw new CredentialsError(
      "AUTH_MISSING",
      `OpenCode authentication file was not found in: ${paths.openCodeAuthCandidates.join(", ")}`
    );
  }
  const auth = await parseJsonFile(
    authPath,
    "AUTH_MISSING",
    "AUTH_INVALID",
    "OpenCode authentication"
  );
  const virtualKeyEntry = auth["cannbot-vk"];
  const virtualKey =
    virtualKeyEntry && typeof virtualKeyEntry === "object"
      ? (virtualKeyEntry as Record<string, unknown>).key
      : undefined;
  if (typeof virtualKey !== "string" || virtualKey.trim() === "") {
    throw new CredentialsError(
      "VIRTUAL_KEY_MISSING",
      "Cannbot virtual key is missing; run `cannbot connect`"
    );
  }

  return { virtualKey };
}
```

Change the credential action in `src/doctor.ts` to:

```ts
"Run `cannbot connect`"
```

Change the managed configuration leak check in `src/default-service.ts` to:

```ts
if (source.includes(credentials.virtualKey)) {
  throw new Error("Cannbot credentials leaked into generated configuration");
}
```

Apply these exact fixture forms in every listed shim/process test:

```ts
readCredentials: async () => ({ virtualKey: "key" })

readCredentials: async () => ({
  virtualKey: `virtual-${++credentialReads}`
})
```

For `test/shim.test.ts` use:

```ts
readCredentials: async () => ({
  virtualKey: "virtual-secret"
})
```

Keep the hostile inbound-header assertion meaningful by sending `"x-api-key": "access-secret"` and retaining:

```ts
assert.doesNotMatch(JSON.stringify(captured[0].headers), /access-secret/);
```

Remove every `writeJsonAtomic(paths.cannbotSession, ...)` call from `test/default-service.test.ts` and `test/model-catalog.test.ts`. Change `assert.doesNotMatch(combined, /access-secret|virtual-secret/)` in `test/default-service.test.ts` to `assert.doesNotMatch(combined, /virtual-secret/)`. Remove `cannbotSession` from the manual `ResolvedPaths` object in `test/processes.test.ts`. Keep all OpenCode `cannbot-vk` fixtures.

- [ ] **Step 4: Run focused and complete tests to verify GREEN**

Run:

```powershell
npm run build
node --test dist/test/credentials.test.js dist/test/doctor.test.js dist/test/default-service.test.js dist/test/model-catalog.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js dist/test/shim.test.js
npm test
```

Expected: all focused tests pass; the complete suite reports at least 101 tests and zero failures.

- [ ] **Step 5: Verify the legacy dependency is gone**

Run:

```powershell
rg -n "cannbotSession|SESSION_MISSING|SESSION_INVALID|ACCESS_TOKEN_MISSING|credentials\.accessToken" src test
git diff --check
```

Expected: `rg` prints no matches; `git diff --check` prints no output. Generic access-token redaction tests remain unchanged.

- [ ] **Step 6: Commit the credential boundary**

```powershell
git add -- src/types.ts src/paths.ts src/credentials.ts src/doctor.ts src/default-service.ts test/credentials.test.ts test/doctor.test.ts test/default-service.test.ts test/model-catalog.test.ts test/processes.test.ts test/shim-ccr-proxy.test.ts test/shim-control.test.ts test/shim-model-discovery.test.ts test/shim-retry.test.ts test/shim-security.test.ts test/shim.test.ts
git commit -m "fix: remove legacy Cannbot session dependency"
```

### Task 2: Document and verify the live Cannbot CLI 1.0.1 flow

**Files:**
- Modify: `README.md:13-35`
- Modify: `README.md:180-192`

**Interfaces:**
- Consumes: virtual-key-only `readCredentials()`, the session-scoped Claude `apiKeyHelper`, and shim `Authorization: Bearer <virtualKey>`.
- Produces: globally installed `cannbot-cc` verified against Cannbot CLI 1.0.1 and CCR 3.0.3 without modifying global Claude or Codex configuration.

- [ ] **Step 1: Update credential-source and security documentation**

Replace the introductory credential paragraph with:

```markdown
The shim rereads the connected `cannbot-vk` from OpenCode `auth.json` for every upstream request and uses it as the compatible-provider Bearer credential. The router does not read the Cannbot login access token or legacy `~/.cannbot/session.json`, and credentials are not copied into this project, CCR configuration, or Claude settings.
```

Replace the matching security bullet with:

```markdown
- The shim rereads only `cannbot-vk` from OpenCode `auth.json` and sends it as the upstream Bearer credential; the Cannbot login access token, legacy session file, and `x-api-vkey` are not read or sent to the model endpoint.
```

- [ ] **Step 2: Run complete automated and package verification**

Run:

```powershell
npm test
npm pack --dry-run
git diff --check
```

Expected: at least 101 tests pass with zero failures; package output includes `dist/src/credentials.js`, `dist/src/claude-launcher.js`, and `dist/src/shim.js`; `git diff --check` prints no output.

- [ ] **Step 3: Rebuild and reinstall the global CLI**

Run:

```powershell
npm run build
npm install -g .
Test-Path "$env:APPDATA\npm\node_modules\cannbot-cc-router\dist\src\cli.js"
```

Expected: both npm commands exit 0 and `Test-Path` returns `True`.

- [ ] **Step 4: Initialize and verify the CCR 3.0.3 lifecycle**

Run:

```powershell
cannbot-cc stop
cannbot-cc init --model glm-5.2 --proxy auto --set-default
cannbot-cc restart --set-default
cannbot-cc doctor --json
cannbot-cc status --json
```

Expected: initialization succeeds using OpenCode `auth.json` without `~/.cannbot/session.json`; doctor reports `"ok":true` and `CCR 3.0.3 is supported`; status reports `{"shim":true,"ccr":true}`. No command writes Codex `config.toml`.

- [ ] **Step 5: Perform the single authorized end-to-end request with cleanup guards**

Run this PowerShell block once:

```powershell
$settingsPath = Join-Path $HOME ".claude\settings.json"
$settingsBefore = if (Test-Path -LiteralPath $settingsPath) {
  (Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash
} else {
  "<missing>"
}
$tempBefore = @(
  Get-ChildItem -Force $env:TEMP -Directory -Filter "cannbot-cc-*" |
    Where-Object {
      $_.Name -notlike "cannbot-cc-credentials-*" -and
      $_.Name -notlike "cannbot-cc-store-*"
    } |
    ForEach-Object { $_.FullName }
)

try {
  $output = @(
    & cannbot-cc code --context 1m -p "Reply with exactly OK" --output-format text 2>&1
  )
  $codeExit = $LASTEXITCODE
  $output | ForEach-Object { $_ }
  $text = $output -join [Environment]::NewLine

  if ($codeExit -ne 0) { throw "End-to-end command exited $codeExit" }
  if ($text -notmatch "(?m)^OK\s*$") { throw "End-to-end output did not contain an exact OK line" }
  if ($text -match "All target providers failed") { throw "CCR reported provider failure" }
  if ($text -match "(?s)(ANTHROPIC_AUTH_TOKEN.*apiKeyHelper|apiKeyHelper.*ANTHROPIC_AUTH_TOKEN)") {
    throw "Claude reported dual authentication"
  }

  $settingsAfter = if (Test-Path -LiteralPath $settingsPath) {
    (Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash
  } else {
    "<missing>"
  }
  if ($settingsBefore -ne $settingsAfter) {
    throw "Global Claude settings changed"
  }

  $tempAfter = @(
    Get-ChildItem -Force $env:TEMP -Directory -Filter "cannbot-cc-*" |
      Where-Object {
        $_.Name -notlike "cannbot-cc-credentials-*" -and
        $_.Name -notlike "cannbot-cc-store-*"
      } |
      ForEach-Object { $_.FullName }
  )
  if (Compare-Object $tempBefore $tempAfter) {
    throw "Claude launcher temporary directory remained"
  }
} finally {
  & cannbot-cc stop
}
```

Expected: output contains an exact `OK` line, contains neither dual-authentication warning nor `All target providers failed`, the global Claude settings hash is unchanged, no launcher temporary directory remains, and the `finally` block stops shim and CCR even if verification fails.

- [ ] **Step 6: Verify stopped state**

Run:

```powershell
cannbot-cc status --json
```

Expected: output is `{"shim":false,"ccr":false}`; exit code 1 is allowed by design.

- [ ] **Step 7: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: describe virtual-key-only credentials"
```

### Task 3: Finish the development branch

**Files:**
- No file changes.

**Interfaces:**
- Consumes: all committed implementation and documentation plus successful live verification.
- Produces: a user-selected merge, pull request, preserved branch, or confirmed discard outcome.

- [ ] **Step 1: Run fresh completion verification**

Run:

```powershell
npm test
git diff --check
git status --short --branch
```

Expected: at least 101 tests pass; no tracked changes remain; the only untracked entry remains `cannbot-cc-router/`.

- [ ] **Step 2: Invoke the branch-finishing workflow**

Use `superpowers:finishing-a-development-branch` and present exactly these choices without acting until the user selects one:

1. Merge back to the detected base branch locally.
2. Push and create a Pull Request.
3. Keep the branch as-is.
4. Discard the work, requiring an explicit typed confirmation before deletion.
