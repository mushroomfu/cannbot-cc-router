# Claude and Cannbot Authentication Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Claude's dual-auth warning and restore successful Cannbot requests through CCR by using a session-scoped Claude API-key helper and Cannbot's virtual key as the upstream Bearer credential.

**Architecture:** `claude-launcher.ts` creates a temporary Node helper beside its temporary settings and overrides only `apiKeyHelper`, leaving all other Claude setting sources enabled. `shim.ts` continues authenticating local clients with its generated secret, then translates that to `Authorization: Bearer <virtualKey>` for Cannbot without forwarding the login access token or `x-api-vkey`.

**Tech Stack:** TypeScript 6, Node.js 20+ ESM, Node test runner, Claude Code CLI, CCR v2 and v3.0.x.

## Global Constraints

- Preserve user, project, and local Claude permissions, hooks, plugins, MCP configuration, and setting-source precedence.
- Never rewrite `~/.claude/settings.json` or expose local secrets, access tokens, or virtual keys.
- Support Windows, Linux, and macOS; CCR support remains v2 and the complete v3.0.x series with v3.0.0 as the minimum verification baseline.
- Do not retry HTTP 500 responses with an alternate authentication method.
- Retain the existing single-flight credential refresh only for HTTP 401 and 403.

---

### Task 1: Session-scoped Claude API-key helper

**Files:**
- Modify: `test/processes-claude.test.ts`
- Modify: `src/claude-launcher.ts`

**Interfaces:**
- Consumes: `runClaudeCode(args, config, options): Promise<number>` and `RunClaudeOptions.spawn`.
- Produces: `apiKeyHelperCommand(nodePath: string, helperPath: string): string`, temporary settings containing `apiKeyHelper`, and a temporary Node helper that prints `config.localSecret`.

- [ ] **Step 1: Write the failing helper test**

Update the first launcher test so its spawn double reads the temporary settings and executes the helper while it exists:

```ts
let helperCommand = "";
let helperOutput = "";
spawn: (_command, receivedArgs) => {
  const settingsIndex = receivedArgs.lastIndexOf("--settings");
  settingsPath = receivedArgs[settingsIndex + 1];
  const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    apiKeyHelper: string;
    env: Record<string, string>;
  };
  settings = parsed;
  helperCommand = parsed.apiKeyHelper;
  const match = /^"([^"]+)" "([^"]+)"$/.exec(helperCommand);
  assert.ok(match);
  helperOutput = execFileSync(match[1], [match[2]], { encoding: "utf8" }).trim();
  return fakeChild(0);
}
```

Assert:

```ts
assert.equal(settings?.env.ANTHROPIC_AUTH_TOKEN, undefined);
assert.equal(helperOutput, "local-secret");
assert.match(helperCommand, /api-key-helper\.mjs/);
assert.equal(existsSync(settingsPath), false);
```

- [ ] **Step 2: Add a failing path-quoting test**

```ts
assert.equal(
  apiKeyHelperCommand("C:\\Program Files\\node.exe", "C:\\Temp Dir\\api-key-helper.mjs"),
  '"C:\\Program Files\\node.exe" "C:\\Temp Dir\\api-key-helper.mjs"'
);
assert.equal(
  apiKeyHelperCommand("/opt/node bin/node", "/tmp/helper dir/api-key-helper.mjs"),
  '"/opt/node bin/node" "/tmp/helper dir/api-key-helper.mjs"'
);
```

- [ ] **Step 3: Run focused tests to verify RED**

Run: `npm run build && node --test dist/test/processes-claude.test.js`

Expected: FAIL because helper behavior does not exist and `ANTHROPIC_AUTH_TOKEN` is present.

- [ ] **Step 4: Implement the temporary helper**

Add to `src/claude-launcher.ts`:

```ts
export function apiKeyHelperCommand(nodePath: string, helperPath: string): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(nodePath)} ${quote(helperPath)}`;
}
```

In `runClaudeCode`, write `api-key-helper.mjs` with mode 0600:

```ts
const helperPath = join(directory, "api-key-helper.mjs");
await writeFile(
  helperPath,
  `process.stdout.write(${JSON.stringify(config.localSecret)});\n`,
  { encoding: "utf8", mode: 0o600 }
);
```

Set `apiKeyHelper: apiKeyHelperCommand(process.execPath, helperPath)` at the settings root and remove `ANTHROPIC_AUTH_TOKEN` from `settings.env`. Do not add `--setting-sources`; unrelated settings must keep loading.

- [ ] **Step 5: Run launcher tests to verify GREEN**

Run: `npm run build && node --test dist/test/processes-claude.test.js dist/test/router-code-launch.test.js`

Expected: all selected tests PASS, including explicit model and `1m` behavior.

- [ ] **Step 6: Commit**

```powershell
git add src/claude-launcher.ts test/processes-claude.test.ts
git commit -m "fix: isolate Claude gateway authentication"
```

### Task 2: Cannbot virtual-key Bearer authentication

**Files:**
- Modify: `test/shim.test.ts`
- Modify: `test/shim-retry.test.ts`
- Modify: `test/shim-security.test.ts`
- Modify: `src/shim.ts`

**Interfaces:**
- Consumes: `CannbotCredentials { accessToken: string; virtualKey: string }` from `readCredentials()`.
- Produces: upstream headers with `authorization: Bearer <virtualKey>` and no `x-api-vkey`, access token, inbound authorization, or inbound API key.

- [ ] **Step 1: Change the forwarding test to the new contract**

```ts
assert.equal(received.headers.authorization, "Bearer virtual-secret");
assert.equal(received.headers["x-api-vkey"], undefined);
assert.doesNotMatch(JSON.stringify(received.headers), /access-secret/);
```

Send hostile inbound `authorization`, `x-api-key`, and `x-api-vkey` headers and assert none reaches the mock upstream.

- [ ] **Step 2: Update retry tests to prove credentials are reread**

```ts
readCredentials: async () => ({
  accessToken: `access-${credentialReads}`,
  virtualKey: `virtual-${++credentialReads}`
})
```

Assert the two attempts receive `Bearer virtual-1` and `Bearer virtual-2`; refresh remains once for 401/403 and shared once across concurrent failures.

- [ ] **Step 3: Run shim tests to verify RED**

Run: `npm run build && node --test dist/test/shim.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js`

Expected: FAIL because the shim sends `Bearer access-*` and `x-api-vkey`.

- [ ] **Step 4: Implement virtual-key Bearer translation**

Replace the owned authentication fields in `upstreamHeaders`:

```ts
headers.authorization = `Bearer ${credentials.virtualKey}`;
headers["content-length"] = String(body.byteLength);
```

Do not set `x-api-vkey`. Keep stripping inbound `authorization`, `x-api-key`, and `x-api-vkey`.

- [ ] **Step 5: Run shim tests to verify GREEN**

Run: `npm run build && node --test dist/test/shim.test.js dist/test/shim-retry.test.js dist/test/shim-security.test.js dist/test/shim-ccr-proxy.test.js`

Expected: all selected tests PASS, including streaming, refresh, local authentication, and CCR proxying.

- [ ] **Step 6: Commit**

```powershell
git add src/shim.ts test/shim.test.ts test/shim-retry.test.ts test/shim-security.test.ts
git commit -m "fix: authenticate Cannbot with virtual key"
```

### Task 3: Documentation, package, and end-to-end verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the Task 1 helper and Task 2 Bearer behavior.
- Produces: an installed global CLI verified against CCR 3.0.3 without modifying global Claude settings.

- [ ] **Step 1: Update security and launch documentation**

```markdown
The shim reads current Cannbot credentials for every upstream request and uses the connected `cannbot-vk` as the compatible-provider Bearer credential. The Cannbot login access token is not forwarded to the model endpoint. Claude receives its loopback secret through a session-scoped temporary `apiKeyHelper`; existing global Claude settings remain unchanged.
```

- [ ] **Step 2: Run complete automated verification**

Run: `npm test`

Expected: 100 or more tests and zero failures.

Run: `npm pack --dry-run`

Expected: exit 0 and package contents include `dist/src/claude-launcher.js` and `dist/src/shim.js`.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 3: Rebuild and reinstall the global CLI**

```powershell
npm run build
npm install -g .
```

Expected: exit 0 and `Test-Path "$env:APPDATA\npm\node_modules\cannbot-cc-router\dist\src\cli.js"` returns `True`.

- [ ] **Step 4: Verify lifecycle without inference**

```powershell
cannbot-cc restart
cannbot-cc doctor --json
cannbot-cc status --json
```

Expected: doctor reports `"ok":true`; status reports `{"shim":true,"ccr":true}`.

- [ ] **Step 5: Perform the authorized end-to-end request**

```powershell
cannbot-cc code --context 1m -p "Reply with exactly OK" --output-format text
```

Expected: output contains `OK`, not the dual-auth warning, and not `All target providers failed`.

- [ ] **Step 6: Stop services and verify cleanup**

```powershell
cannbot-cc stop
cannbot-cc status --json
```

Expected: stop reports both true; status reports both false and may exit 1 by design. Confirm no temporary directory from this run remains.

- [ ] **Step 7: Commit documentation**

```powershell
git add README.md
git commit -m "docs: describe isolated gateway authentication"
```
