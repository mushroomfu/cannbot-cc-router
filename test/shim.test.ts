import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

interface CapturedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

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
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function post(port: number, authorization: string, body: string, extraHeaders: Record<string, string> = {}): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        ...extraHeaders,
        authorization,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
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

test("authenticates locally and injects current Cannbot credentials", async (t) => {
  const captured: CapturedRequest[] = [];
  const upstream = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      captured.push({ headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const shim = createShim({
    localSecret: "local-secret",
    models: ["glm-5.2"],
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({
      virtualKey: "virtual-secret"
    }),
    refreshCredentials: async () => undefined
  });
  const shimAddress = await shim.listen();
  t.after(() => shim.close());

  const body = '{"model":"glm-5.2","stream":true}';
  const result = await post(shimAddress.port, "Bearer local-secret", body, {
    "x-api-key": "access-secret",
    "x-api-vkey": "attacker-vkey"
  });

  assert.deepEqual(result, { status: 200, body: '{"ok":true}' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body, body);
  assert.equal(captured[0].headers.authorization, "Bearer virtual-secret");
  assert.equal(captured[0].headers["x-api-key"], undefined);
  assert.equal(captured[0].headers["x-api-vkey"], undefined);
  assert.doesNotMatch(JSON.stringify(captured[0].headers), /access-secret/);
  assert.equal(captured[0].headers.host, `127.0.0.1:${upstreamPort}`);
});

test("rejects an incorrect local secret without contacting upstream", async (t) => {
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
    ccrUrl: "http://127.0.0.1:3456",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    proxyMode: "direct",
    readCredentials: async () => ({ virtualKey: "virtual" }),
    refreshCredentials: async () => undefined
  });
  const shimAddress = await shim.listen();
  t.after(() => shim.close());

  const result = await post(shimAddress.port, "Bearer wrong-secret", "{}");

  assert.equal(result.status, 401);
  assert.equal(upstreamRequests, 0);
});
