import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CredentialsError, readCredentials } from "../src/credentials.js";
import { resolvePaths } from "../src/paths.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cannbot-cc-credentials-"));
}

test("reads current access token and virtual key", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await writeJson(paths.cannbotSession, { accessToken: "access-secret" });
  await writeJson(paths.openCodeAuthCandidates[0], {
    cannbot: { type: "oauth", access: "oauth-access", refresh: "refresh-secret" },
    "cannbot-vk": { type: "api", key: "virtual-secret" }
  });

  assert.deepEqual(await readCredentials(paths), {
    accessToken: "access-secret",
    virtualKey: "virtual-secret"
  });
});

test("supports the Windows OpenCode auth candidate", async () => {
  const home = await temporaryHome();
  const appData = join(home, "AppData", "Roaming");
  const paths = resolvePaths({ home, platform: "win32", env: { APPDATA: appData } });
  await writeJson(paths.cannbotSession, { accessToken: "access-secret" });
  await writeJson(paths.openCodeAuthCandidates.at(-1)!, {
    "cannbot-vk": { key: "virtual-secret" }
  });

  assert.equal((await readCredentials(paths)).virtualKey, "virtual-secret");
});

test("reports a missing Cannbot session", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await assert.rejects(readCredentials(paths), (error: unknown) => {
    assert.ok(error instanceof CredentialsError);
    assert.equal(error.code, "SESSION_MISSING");
    return true;
  });
});

test("reports malformed credential JSON without exposing content", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await mkdir(dirname(paths.cannbotSession), { recursive: true });
  await writeFile(paths.cannbotSession, "{not-json access-secret", "utf8");

  await assert.rejects(readCredentials(paths), (error: unknown) => {
    assert.ok(error instanceof CredentialsError);
    assert.equal(error.code, "SESSION_INVALID");
    assert.doesNotMatch(error.message, /access-secret/);
    return true;
  });
});

test("requires non-empty access token and virtual key", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await writeJson(paths.cannbotSession, { accessToken: "" });
  await assert.rejects(readCredentials(paths), { code: "ACCESS_TOKEN_MISSING" });

  await writeJson(paths.cannbotSession, { accessToken: "access-secret" });
  await writeJson(paths.openCodeAuthCandidates[0], { "cannbot-vk": { key: "" } });
  await assert.rejects(readCredentials(paths), { code: "VIRTUAL_KEY_MISSING" });
});
