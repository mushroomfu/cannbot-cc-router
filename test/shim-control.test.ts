import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No address"));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function call(port: number, options: {
  method?: string;
  path: string;
  secret?: string;
  instanceId?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: options.path,
      method: options.method ?? "GET",
      headers: {
        ...(options.secret ? { authorization: `Bearer ${options.secret}` } : {}),
        ...(options.instanceId ? { "x-shim-instance": options.instanceId } : {}),
        ...(body ? { "content-length": Buffer.byteLength(body) } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

test("reports health and requires both secret and instance marker to stop", async () => {
  const shim = createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    ccrApiKey: "ccr-test-key",
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: "access", virtualKey: "key" }),
    refreshCredentials: async () => undefined
  });
  const address = await shim.listen();

  const health = await call(address.port, { path: "/health" });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), {
    status: "ok",
    instanceId: shim.instanceId,
    pid: process.pid
  });
  assert.equal((await call(address.port, {
    method: "POST",
    path: "/shutdown",
    secret: "wrong",
    instanceId: shim.instanceId
  })).status, 401);
  assert.equal((await call(address.port, {
    method: "POST",
    path: "/shutdown",
    secret: "local-secret",
    instanceId: "wrong-instance"
  })).status, 409);
  assert.equal((await call(address.port, {
    method: "POST",
    path: "/shutdown",
    secret: "local-secret",
    instanceId: shim.instanceId
  })).status, 202);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(call(address.port, { path: "/health" }), /ECONNREFUSED|socket hang up/);
});

test("rejects a request body larger than the configured limit", async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_incoming, response) => {
    upstreamRequests += 1;
    response.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const shim = createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrApiKey: "ccr-test-key",
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    maxBodyBytes: 5,
    readCredentials: async () => ({ accessToken: "access", virtualKey: "key" }),
    refreshCredentials: async () => undefined
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await call(address.port, {
    method: "POST",
    path: "/v1/chat/completions",
    secret: "local-secret",
    body: "123456"
  });
  assert.equal(result.status, 413);
  assert.equal(upstreamRequests, 0);
});
