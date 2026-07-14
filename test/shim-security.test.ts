import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("No address"));
    resolve(address.port);
  }));
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
      headers: { authorization: "Bearer local-secret" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end("{}");
  });
}

test("rereads credentials for every independent request", async (t) => {
  const received: Array<{
    authorization: string | undefined;
    virtualKey: string | string[] | undefined;
  }> = [];
  const upstream = createServer((incoming, response) => {
    received.push({
      authorization: incoming.headers.authorization,
      virtualKey: incoming.headers["x-api-vkey"]
    });
    response.end("ok");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  let reads = 0;
  const shim = createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({
      accessToken: `access-${reads}`,
      virtualKey: `virtual-${++reads}`
    }),
    refreshCredentials: async () => undefined
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  await post(address.port);
  await post(address.port);
  assert.deepEqual(received.map(({ authorization }) => authorization), [
    "Bearer virtual-1",
    "Bearer virtual-2"
  ]);
  assert.deepEqual(received.map(({ virtualKey }) => virtualKey), [undefined, undefined]);
  assert.doesNotMatch(JSON.stringify(received), /access-/);
});

test("does not expose internal error details to local clients", async (t) => {
  const shim = createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    proxyMode: "direct",
    readCredentials: async () => { throw new Error("access-secret must stay private"); },
    refreshCredentials: async () => undefined
  });
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await post(address.port);
  assert.equal(result.status, 502);
  assert.equal(result.body, '{"error":"upstream_failure"}');
  assert.doesNotMatch(result.body, /access-secret/);
});
