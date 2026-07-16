import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolvePaths } from "../src/paths.js";

test("resolves only project-owned and Cannbot credential paths", () => {
  const home = "C:\\Users\\u";
  const paths = resolvePaths({
    home,
    platform: "win32",
    env: { APPDATA: "D:\\AppData" }
  });

  assert.deepEqual(Object.keys(paths).sort(), [
    "home",
    "openCodeAuthCandidates",
    "projectConfig",
    "projectDir"
  ]);
  assert.equal(paths.projectDir, join(home, ".cannbot-cc-router"));
  assert.equal(paths.projectConfig, join(home, ".cannbot-cc-router", "config.json"));
  assert.deepEqual(paths.openCodeAuthCandidates, [
    join(home, ".local", "share", "opencode", "auth.json"),
    join("D:\\AppData", "opencode", "auth.json")
  ]);
});

test("honors XDG data location without resolving shared CCR state", () => {
  const paths = resolvePaths({
    home: "/home/u",
    platform: "linux",
    env: { XDG_DATA_HOME: "/srv/data" }
  });
  assert.deepEqual(paths.openCodeAuthCandidates, [
    join("/srv/data", "opencode", "auth.json")
  ]);
  assert.doesNotMatch(JSON.stringify(paths), /claude-code-router|config\.sqlite|api-keys/);
});
