import assert from "node:assert/strict";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server
} from "node:http";
import test from "node:test";

import { createShim } from "../src/shim.js";

interface Captured {
  url: string;
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

function post(port: number, path: string, body: string): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        authorization: "Bearer local-secret",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function shimFor(ccrPort: number) {
  return createShim({
    localSecret: "local-secret",
    models: ["deepseek-v4-pro", "glm-5.2"],
    ccrUrl: `http://127.0.0.1:${ccrPort}`,
    ccrApiKey: "ccr-local-key",
    upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
    proxyMode: "direct",
    readCredentials: async () => ({
      accessToken: "cannbot-access-secret",
      virtualKey: "cannbot-virtual-secret"
    }),
    refreshCredentials: async () => undefined
  } as Parameters<typeof createShim>[0]);
}

test("rewrites a discovered model and proxies Anthropic JSON to CCR", async (t) => {
  const captured: Captured[] = [];
  const ccr = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      captured.push({
        url: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"input_tokens":17}');
    });
  });
  const ccrPort = await listen(ccr);
  t.after(() => close(ccr));
  const shim = shimFor(ccrPort);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await post(address.port, "/v1/messages/count_tokens?beta=true", JSON.stringify({
    model: "anthropic/cannbot/glm-5.2",
    messages: [{ role: "user", content: "hello" }]
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body, '{"input_tokens":17}');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "/v1/messages/count_tokens?beta=true");
  assert.equal(captured[0].headers["x-api-key"], "ccr-local-key");
  assert.notEqual(captured[0].headers.authorization, "Bearer local-secret");
  assert.doesNotMatch(JSON.stringify(captured[0]), /cannbot-access-secret|cannbot-virtual-secret/);
  assert.deepEqual(JSON.parse(captured[0].body), {
    model: "glm-5.2",
    messages: [{ role: "user", content: "hello" }]
  });
});

test("removes Claude's 1M context suffix before forwarding to CCR", async (t) => {
  const captured: Captured[] = [];
  const ccr = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      captured.push({
        url: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.end("{}");
    });
  });
  const ccrPort = await listen(ccr);
  t.after(() => close(ccr));
  const shim = shimFor(ccrPort);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await post(address.port, "/v1/messages", JSON.stringify({
    model: "anthropic/cannbot/glm-5.2[1m]",
    messages: []
  }));

  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(captured[0].body), {
    model: "glm-5.2",
    messages: []
  });
});

test("streams CCR SSE responses through the Anthropic messages path", async (t) => {
  const ccr = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
    setTimeout(() => response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"), 10);
  });
  const ccrPort = await listen(ccr);
  t.after(() => close(ccr));
  const shim = shimFor(ccrPort);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await post(address.port, "/v1/messages?beta=true", JSON.stringify({
    model: "anthropic/cannbot/deepseek-v4-pro",
    messages: []
  }));
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "text/event-stream");
  assert.match(result.body, /message_start/);
  assert.match(result.body, /message_stop/);
});

test("rejects an unknown namespaced model before contacting CCR", async (t) => {
  let calls = 0;
  const ccr = createServer((_incoming, response) => {
    calls += 1;
    response.end();
  });
  const ccrPort = await listen(ccr);
  t.after(() => close(ccr));
  const shim = shimFor(ccrPort);
  const address = await shim.listen();
  t.after(() => shim.close());

  const result = await post(address.port, "/v1/messages?beta=true", JSON.stringify({
    model: "anthropic/cannbot/not-available",
    messages: []
  }));
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
  assert.equal(result.body, '{"error":"unsupported_model"}');
});

test("sanitizes a failed CCR connection", async (t) => {
  const shim = shimFor(1);
  const address = await shim.listen();
  t.after(() => shim.close());
  const result = await post(address.port, "/v1/messages?beta=true", JSON.stringify({
    model: "anthropic/cannbot/glm-5.2",
    messages: []
  }));
  assert.equal(result.status, 502);
  assert.equal(result.body, '{"error":"upstream_failure"}');
});
