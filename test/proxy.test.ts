import assert from "node:assert/strict";
import test from "node:test";

import {
  childProxyEnv,
  createProxyAgent,
  mergeNoProxy,
  selectProxy
} from "../src/proxy.js";

const CANNBOT_URL =
  "https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions";

test("auto mode prefers HTTPS proxy and bypasses loopback", () => {
  const env = {
    HTTPS_PROXY: "http://127.0.0.1:10808",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1"
  };

  assert.equal(selectProxy(CANNBOT_URL, "auto", env), "http://127.0.0.1:10808");
  assert.equal(selectProxy("http://127.0.0.1:8787/health", "auto", env), "");
  assert.equal(selectProxy("http://localhost:3456/status", "auto", env), "");
});

test("direct and explicit modes are deterministic", () => {
  assert.equal(selectProxy(CANNBOT_URL, "direct", { HTTPS_PROXY: "http://proxy" }), "");
  assert.equal(selectProxy(CANNBOT_URL, "http://127.0.0.1:8080", {}), "http://127.0.0.1:8080");
  assert.equal(selectProxy(CANNBOT_URL, "socks5://127.0.0.1:1080", {}), "socks5://127.0.0.1:1080");
  assert.throws(() => selectProxy(CANNBOT_URL, "ftp://127.0.0.1", {}), /Unsupported proxy protocol/);
});

test("NO_PROXY merging preserves entries and adds loopback once", () => {
  assert.equal(mergeNoProxy("example.com"), "example.com,localhost,127.0.0.1");
  assert.equal(
    mergeNoProxy("localhost,127.0.0.1,example.com"),
    "localhost,127.0.0.1,example.com"
  );
  const env = childProxyEnv({ no_proxy: "example.org", PATH: "keep" });
  assert.equal(env.NO_PROXY, "example.org,localhost,127.0.0.1");
  assert.equal(env.no_proxy, "example.org,localhost,127.0.0.1");
  assert.equal(env.PATH, "keep");
});

test("creates HTTP and SOCKS agents", () => {
  assert.equal(createProxyAgent(""), undefined);
  assert.match(createProxyAgent("http://127.0.0.1:8080")!.constructor.name, /HttpsProxyAgent/);
  assert.match(createProxyAgent("socks5://127.0.0.1:1080")!.constructor.name, /SocksProxyAgent/);
});
