import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address"));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function call(port: number, options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: options.path,
      method: options.method,
      headers: {
        ...options.headers,
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

function createTestShim(upstreamUrl: string) {
  return createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl,
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: "access-secret", virtualKey: "virtual-secret" }),
    refreshCredentials: async () => undefined
  });
}

test("accepts x-api-key when Authorization is overwritten and strips both local credentials", async (t) => {
  let headers: IncomingHttpHeaders | undefined;
  const upstream = createServer((incoming, response) => {
    headers = incoming.headers;
    response.end("ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const shim = createTestShim(`http://127.0.0.1:${upstreamPort}/v1/chat/completions`);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await call(address.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { authorization: "Bearer overridden", "x-api-key": "local-secret", "x-api-vkey": "attacker" },
    body: "{}"
  });

  assert.equal(result.status, 200);
  assert.equal(headers?.authorization, "Bearer virtual-secret");
  assert.equal(headers?.["x-api-key"], undefined);
  assert.equal(headers?.["x-api-vkey"], undefined);
});

test("accepts x-api-key without an Authorization header", async (t) => {
  const upstream = createServer((_incoming, response) => response.end("ok"));
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const shim = createTestShim(`http://127.0.0.1:${upstreamPort}/v1/chat/completions`);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await call(address.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "x-api-key": "local-secret" },
    body: "{}"
  });

  assert.equal(result.status, 200);
});

test("rejects an incorrect x-api-key without contacting upstream", async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_incoming, response) => {
    upstreamRequests += 1;
    response.end("ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const shim = createTestShim(`http://127.0.0.1:${upstreamPort}/v1/chat/completions`);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await call(address.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "x-api-key": "wrong-secret" },
    body: "{}"
  });

  assert.equal(result.status, 401);
  assert.equal(upstreamRequests, 0);
});

test("accepts x-api-key for protected model discovery", async (t) => {
  const shim = createTestShim("http://127.0.0.1:1/v1/chat/completions");
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await call(address.port, {
    method: "GET",
    path: "/v1/models",
    headers: { "x-api-key": "local-secret" }
  });

  assert.equal(result.status, 200);
});

test("accepts x-api-key for protected shutdown when Authorization is overwritten", async (t) => {
  const shim = createTestShim("http://127.0.0.1:1/v1/chat/completions");
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await call(address.port, {
    method: "POST",
    path: "/shutdown",
    headers: {
      authorization: "Bearer overridden",
      "x-api-key": "local-secret",
      "x-shim-instance": shim.instanceId
    }
  });

  assert.equal(result.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
});
