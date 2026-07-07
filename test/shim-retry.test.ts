import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
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

function post(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end('{"model":"glm-5.2"}');
  });
}

test("refreshes once and retries with newly read credentials", async (t) => {
  const authorizations: Array<string | undefined> = [];
  const upstream = createServer((incoming, response) => {
    authorizations.push(incoming.headers.authorization);
    if (authorizations.length === 1) response.writeHead(401).end("expired");
    else response.writeHead(200).end("ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  let token = "old-token";
  let refreshes = 0;
  const shim = createShim({
    localSecret: "local-secret",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: token, virtualKey: "virtual" }),
    refreshCredentials: async () => {
      refreshes += 1;
      token = "new-token";
    }
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  assert.deepEqual(await post(address.port), { status: 200, body: "ok" });
  assert.equal(refreshes, 1);
  assert.deepEqual(authorizations, ["Bearer old-token", "Bearer new-token"]);
});

test("shares one refresh across concurrent authentication failures", async (t) => {
  let token = "old-token";
  let refreshes = 0;
  let requests = 0;
  const upstream = createServer((incoming, response) => {
    requests += 1;
    if (incoming.headers.authorization === "Bearer old-token") response.writeHead(401).end();
    else response.writeHead(200).end("ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const shim = createShim({
    localSecret: "local-secret",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: token, virtualKey: "virtual" }),
    refreshCredentials: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      token = "new-token";
    }
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  const results = await Promise.all([post(address.port), post(address.port)]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.equal(refreshes, 1);
  assert.equal(requests, 4);
});

test("does not retry a second authentication failure", async (t) => {
  let requests = 0;
  let refreshes = 0;
  const upstream = createServer((_incoming, response) => {
    requests += 1;
    response.writeHead(403).end("denied");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const shim = createShim({
    localSecret: "local-secret",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: "token", virtualKey: "virtual" }),
    refreshCredentials: async () => { refreshes += 1; }
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  assert.deepEqual(await post(address.port), { status: 403, body: "denied" });
  assert.equal(refreshes, 1);
  assert.equal(requests, 2);
});

test("streams SSE chunks before the upstream response ends", async (t) => {
  const upstream = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
    setTimeout(() => response.write("data: two\n\n"), 20);
    setTimeout(() => response.end("data: done\n\n"), 40);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const shim = createShim({
    localSecret: "local-secret",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({ accessToken: "token", virtualKey: "virtual" }),
    refreshCredentials: async () => undefined
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  let resolveFirst!: (value: string) => void;
  let resolveComplete!: (value: string) => void;
  const first = new Promise<string>((resolve) => { resolveFirst = resolve; });
  const complete = new Promise<string>((resolve) => { resolveComplete = resolve; });
  const outgoing = request({
    host: "127.0.0.1",
    port: address.port,
    path: "/v1/chat/completions",
    method: "POST",
    headers: { authorization: "Bearer local-secret" }
  }, (response) => {
    const chunks: string[] = [];
    response.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      chunks.push(value);
      if (chunks.length === 1) resolveFirst(value);
    });
    response.on("end", () => resolveComplete(chunks.join("")));
  });
  outgoing.end("{}");

  assert.equal(await first, "data: one\n\n");
  assert.equal(await complete, "data: one\n\ndata: two\n\ndata: done\n\n");
});
