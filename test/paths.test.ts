import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolvePaths } from "../src/paths.js";

test("resolves the CCR v3 Windows database layout", () => {
  const paths = resolvePaths({
    home: "C:\\Users\\u",
    platform: "win32",
    env: { APPDATA: "D:\\AppData" }
  });
  assert.equal(paths.ccrV3ConfigDb, join("D:\\AppData", "claude-code-router", "config.sqlite"));
  assert.equal(paths.ccrV3ApiKeysDb, join("D:\\AppData", "claude-code-router", "api-keys.sqlite"));
});

test("resolves the CCR v3 Linux and macOS database layout", () => {
  for (const [platform, home] of [["linux", "/home/u"], ["darwin", "/Users/u"]] as const) {
    const paths = resolvePaths({ home, platform, env: {} });
    assert.equal(paths.ccrV3ConfigDb, join(home, ".claude-code-router", "config.sqlite"));
    assert.equal(paths.ccrV3ApiKeysDb, join(home, ".claude-code-router", "app-data", "api-keys.sqlite"));
  }
});

test("honors CCR internal directory overrides", () => {
  const paths = resolvePaths({
    home: "/home/u",
    platform: "linux",
    env: {
      CCR_INTERNAL_HOME_DIR: "/srv/ccr-home",
      CCR_INTERNAL_APP_DATA_DIR: "/srv/ccr-appdata",
      CCR_INTERNAL_USER_DATA_DIR: "/srv/ccr-userdata"
    }
  });
  assert.equal(paths.ccrV3ConfigDb, join("/srv/ccr-home", ".claude-code-router", "config.sqlite"));
  assert.equal(paths.ccrV3ApiKeysDb, join("/srv/ccr-userdata", "api-keys.sqlite"));
});
