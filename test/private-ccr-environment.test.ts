import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import test from "node:test";

import { createPrivateCcrEnvironment } from "../src/private-ccr-environment.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertInside(root: string, candidate: string): void {
  if (candidate === root) return;
  const resolved = relative(root, candidate);
  assert.notEqual(resolved, "");
  assert.ok(!isAbsolute(resolved));
  assert.ok(resolved !== "..");
  assert.ok(!resolved.startsWith(`..${sep}`));
}

test("private CCR environment is child-only, fully contained, and disposable", async () => {
  const parentEnv: NodeJS.ProcessEnv = {
    APPDATA: "shared-app-data",
    CODEX_HOME: "must-not-leak",
    HOME: "shared-home",
    LOCALAPPDATA: "shared-local-app-data",
    PATH: process.env.PATH ?? "path",
    SOME_UNRELATED_SECRET: "must-not-leak",
    TEMP: "shared-temp",
    TMP: "shared-tmp",
    USERPROFILE: "shared-user-profile"
  };
  const before = { ...parentEnv };
  const session = await createPrivateCcrEnvironment({ parentEnv });

  try {
    assert.deepEqual(parentEnv, before);
    assert.equal(session.env.CODEX_HOME, undefined);
    assert.equal(session.env.SOME_UNRELATED_SECRET, undefined);
    assert.equal(session.env.PATH, parentEnv.PATH);
    assert.equal(session.env.HOME, session.paths.home);
    assert.equal(session.env.USERPROFILE, session.paths.home);
    assert.equal(session.env.APPDATA, session.paths.appData);
    assert.equal(session.env.LOCALAPPDATA, session.paths.appData);
    assert.equal(session.env.TEMP, session.paths.temp);
    assert.equal(session.env.TMP, session.paths.temp);
    assert.equal(session.env.XDG_CONFIG_HOME, session.paths.xdgConfig);
    assert.equal(session.env.XDG_DATA_HOME, session.paths.xdgData);
    assert.equal(session.env.CCR_INTERNAL_HOME_DIR, session.paths.home);
    assert.equal(session.env.CCR_INTERNAL_APP_DATA_DIR, session.paths.appData);
    assert.equal(session.env.CCR_INTERNAL_USER_DATA_DIR, session.paths.userData);

    for (const path of Object.values(session.paths)) {
      assertInside(session.paths.root, path);
      assert.equal(await exists(path), true);
    }
  } finally {
    await session.dispose();
  }

  assert.equal(await exists(session.paths.root), false);
  await session.dispose();
  assert.equal(await exists(session.paths.root), false);
});
