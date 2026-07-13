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

test("reads OpenCode credentials without a Cannbot session", async () => {
  const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
  await writeJson(paths.openCodeAuthCandidates[0], {
    cannbot: { type: "oauth", access: "access-secret" },
    "cannbot-vk": { type: "api", key: "virtual-secret" }
  });

  assert.deepEqual(await readCredentials(paths), {
    accessToken: "access-secret",
    virtualKey: "virtual-secret"
  });
});

test("requires a non-empty Cannbot access token", async () => {
  for (const cannbot of [
    undefined,
    { type: "oauth", access: "", refresh: "" }
  ]) {
    const paths = resolvePaths({ home: await temporaryHome(), platform: "linux" });
    await writeJson(paths.openCodeAuthCandidates[0], {
      ...(cannbot === undefined ? {} : { cannbot }),
      "cannbot-vk": { type: "api", key: "virtual-secret" }
    });
    await assert.rejects(readCredentials(paths), { code: "ACCESS_TOKEN_MISSING" });
  }
});

test("supports the Windows OpenCode auth candidate", async () => {
  const home = await temporaryHome();
  const appData = join(home, "AppData", "Roaming");
  const paths = resolvePaths({ home, platform: "win32", env: { APPDATA: appData } });
  await writeJson(paths.openCodeAuthCandidates.at(-1)!, {
    cannbot: { type: "oauth", access: "access-secret" },
    "cannbot-vk": { key: "virtual-secret" }
  });

  assert.deepEqual(await readCredentials(paths), {
    accessToken: "access-secret",
    virtualKey: "virtual-secret"
  });
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
  await writeJson(paths.openCodeAuthCandidates[0], {
    cannbot: { type: "oauth", access: "access-secret" },
    "cannbot-vk": { key: "" }
  });
  await assert.rejects(readCredentials(paths), { code: "VIRTUAL_KEY_MISSING" });
});
