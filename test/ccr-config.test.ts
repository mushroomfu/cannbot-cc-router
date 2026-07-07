import assert from "node:assert/strict";
import test from "node:test";

import { reconcileCcrConfig } from "../src/ccr-config.js";

const existing = {
  LOG: false,
  Providers: [
    { name: "volcengine", api_key: "one", models: ["model-one"] },
    { name: "bailian", api_key: "two", models: ["model-two"] },
    { name: "zenmux", api_key: "three", models: ["model-three"] }
  ],
  Router: {
    default: "zenmux,model-three",
    think: "bailian,model-two",
    background: "volcengine,model-one",
    longContext: "zenmux,model-three"
  }
};

test("adds the managed Cannbot provider and preserves unrelated configuration", () => {
  const merged = reconcileCcrConfig(existing, {
    shimPort: 8787,
    localSecret: "local-only",
    model: "glm-5.2",
  models: ["glm-5.2"],
    setDefault: true
  });

  assert.equal(merged.Providers.length, 4);
  assert.deepEqual(merged.Providers.find((provider) => provider.name === "cannbot"), {
    name: "cannbot",
    api_base_url: "http://127.0.0.1:8787/v1/chat/completions",
    api_key: "local-only",
    models: ["glm-5.2"],
    transformer: { use: ["openai"] }
  });
  assert.equal(merged.Router.default, "cannbot,glm-5.2");
  assert.equal(merged.Router.think, "cannbot,glm-5.2");
  assert.equal(merged.LOG, false);
  assert.equal(existing.Providers.length, 3, "input must not be mutated");
});

test("reconciliation is idempotent and replaces only the named provider", () => {
  const withOldCannbot = {
    ...existing,
    Providers: [
      ...existing.Providers,
      { name: "cannbot", api_key: "stale", custom: "discard-owned-provider" }
    ]
  };
  const options = {
    shimPort: 9000,
    localSecret: "new-local-secret",
    model: "glm-5.2",
  models: ["glm-5.2"],
    setDefault: false
  };
  const once = reconcileCcrConfig(withOldCannbot, options);
  const twice = reconcileCcrConfig(once, options);

  assert.deepEqual(twice, once);
  assert.equal(twice.Providers.filter((provider) => provider.name === "cannbot").length, 1);
  assert.equal(twice.Router.default, existing.Router.default);
});

test("rejects malformed CCR configuration shapes", () => {
  assert.throws(() => reconcileCcrConfig(null, {
    shimPort: 8787,
    localSecret: "secret",
    model: "glm-5.2",
  models: ["glm-5.2"],
    setDefault: true
  }), /object/);
  assert.throws(() => reconcileCcrConfig({ Providers: {}, Router: {} }, {
    shimPort: 8787,
    localSecret: "secret",
    model: "glm-5.2",
  models: ["glm-5.2"],
    setDefault: true
  }), /Providers/);
});
