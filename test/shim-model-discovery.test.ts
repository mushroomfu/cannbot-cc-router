import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

function get(port: number, authorization?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/v1/models?limit=1000",
      method: "GET",
      headers: authorization ? { authorization } : {}
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("serves the authenticated Cannbot model catalog with namespaced IDs", async (t) => {
  const shim = createShim({
    localSecret: "local-secret",
    models: ["deepseek-v4-pro", "glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    ccrApiKey: "ccr-local-key",
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: "access", virtualKey: "virtual" }),
    refreshCredentials: async () => undefined
  } as Parameters<typeof createShim>[0]);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await get(address.port, "Bearer local-secret");
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), {
    object: "list",
    data: [
      { id: "anthropic/cannbot/deepseek-v4-pro", display_name: "Cannbot · deepseek-v4-pro", object: "model", owned_by: "cannbot" },
      { id: "anthropic/cannbot/glm-5.2", display_name: "Cannbot · glm-5.2", object: "model", owned_by: "cannbot" }
    ]
  });
});

test("does not disclose model IDs without the local token", async (t) => {
  const shim = createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    ccrApiKey: "ccr-test-key",
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: "access", virtualKey: "virtual" }),
    refreshCredentials: async () => undefined
  } as Parameters<typeof createShim>[0]);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await get(address.port);
  assert.equal(result.status, 401);
  assert.doesNotMatch(result.body, /glm-5\.2/);
});
