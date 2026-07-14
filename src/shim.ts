import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";

import { createProxyAgent, selectProxy } from "./proxy.js";
import type { CannbotCredentials } from "./types.js";

export interface ShimOptions {
  localSecret: string;
  models: readonly string[];
  ccrUrl: string;
  ccrApiKey?: string;
  upstreamUrl: string;
  proxyMode: string;
  env?: NodeJS.ProcessEnv;
  host?: "127.0.0.1";
  port?: number;
  maxBodyBytes?: number;
  readCredentials(): Promise<CannbotCredentials>;
  refreshCredentials(): Promise<void>;
}

export interface ShimAddress {
  host: "127.0.0.1";
  port: number;
}

export interface Shim {
  readonly instanceId: string;
  listen(): Promise<ShimAddress>;
  close(): Promise<void>;
  address(): ShimAddress | undefined;
}

class BodyTooLargeError extends Error {}
class InvalidRequestError extends Error {}
class UnsupportedModelError extends Error {}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const CCR_PATHS = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens"
]);

function secretsEqual(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(actual.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function collectBody(incoming: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    incoming.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maximum) {
        settled = true;
        reject(new BodyTooLargeError("Request body is too large"));
        incoming.resume();
        return;
      }
      chunks.push(chunk);
    });
    incoming.once("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    incoming.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function copiedHeaders(
  incoming: IncomingHttpHeaders
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === "host" ||
      lower === "authorization" ||
      lower === "x-api-key" ||
      lower === "x-api-vkey" ||
      lower === "content-length"
    ) continue;
    headers[lower] = value;
  }
  return headers;
}

function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  credentials: CannbotCredentials,
  body: Buffer
): Record<string, string | string[]> {
  const headers = copiedHeaders(incoming);
  headers.authorization = `Bearer ${credentials.virtualKey}`;
  headers["content-length"] = String(body.byteLength);
  return headers;
}

function ccrHeaders(
  incoming: IncomingHttpHeaders,
  apiKey: string | undefined,
  body: Buffer
): Record<string, string | string[]> {
  const headers = copiedHeaders(incoming);
  headers["x-api-key"] = apiKey ?? "test";
  headers["content-length"] = String(body.byteLength);
  return headers;
}

function makeUpstreamRequest(
  options: ShimOptions,
  incomingHeaders: IncomingHttpHeaders,
  body: Buffer
): Promise<IncomingMessage> {
  return options.readCredentials().then((credentials) => new Promise((resolve, reject) => {
    const target = new URL(options.upstreamUrl);
    const proxyUrl = selectProxy(target.href, options.proxyMode, options.env);
    const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = requester({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: "POST",
      path: `${target.pathname}${target.search}`,
      headers: upstreamHeaders(incomingHeaders, credentials, body),
      agent: createProxyAgent(proxyUrl)
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end(body);
  }));
}

function makeCcrRequest(
  options: ShimOptions,
  path: string,
  incomingHeaders: IncomingHttpHeaders,
  body: Buffer
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, options.ccrUrl);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1"
    ) {
      reject(new Error("CCR URL must be loopback HTTP"));
      return;
    }
    const outgoing = httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: target.port || "80",
      method: "POST",
      path: `${target.pathname}${target.search}`,
      headers: ccrHeaders(incomingHeaders, options.ccrApiKey, body)
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function rewriteClaudeModel(body: Buffer, models: readonly string[]): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new InvalidRequestError("Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidRequestError("Request body must be an object");
  }
  const requestBody = parsed as Record<string, unknown>;
  if (typeof requestBody.model === "string" && requestBody.model.startsWith("anthropic/cannbot/")) {
    const requestedModel = requestBody.model.slice("anthropic/cannbot/".length);
    const model = requestedModel.endsWith("[1m]")
      ? requestedModel.slice(0, -"[1m]".length)
      : requestedModel;
    if (!models.includes(model)) {
      throw new UnsupportedModelError("Unsupported Cannbot model");
    }
    requestBody.model = model;
  }
  return Buffer.from(JSON.stringify(requestBody));
}

function drainResponse(upstream: IncomingMessage): Promise<void> {
  if (upstream.complete) return Promise.resolve();
  return new Promise((resolve, reject) => {
    upstream.once("end", resolve);
    upstream.once("error", reject);
    upstream.resume();
  });
}

function copyResponse(upstream: IncomingMessage, response: ServerResponse): void {
  response.statusCode = upstream.statusCode ?? 502;
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  }
  upstream.pipe(response);
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, { "content-type": "application/json" });
  response.end('{"error":"unauthorized"}');
}

export function createShim(options: ShimOptions): Shim {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maximumBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const instanceId = randomUUID();
  let boundAddress: ShimAddress | undefined;
  let refreshPromise: Promise<void> | undefined;

  const refreshOnce = async (): Promise<void> => {
    if (!refreshPromise) {
      refreshPromise = options.refreshCredentials().finally(() => {
        refreshPromise = undefined;
      });
    }
    await refreshPromise;
  };

  const server: Server = createServer(async (incoming, response) => {
    const pathname = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
    if (incoming.method === "GET" && pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", instanceId, pid: process.pid }));
      return;
    }

    if (incoming.method === "GET" && pathname === "/v1/models") {
      if (!secretsEqual(incoming.headers.authorization, options.localSecret)) {
        unauthorized(response);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: options.models.map((model) => ({
          id: `anthropic/cannbot/${model}`,
          display_name: `Cannbot · ${model}`,
          object: "model",
          owned_by: "cannbot"
        }))
      }));
      return;
    }

    if (incoming.method === "POST" && pathname === "/shutdown") {
      if (!secretsEqual(incoming.headers.authorization, options.localSecret)) {
        response.writeHead(401).end();
        return;
      }
      if (incoming.headers["x-shim-instance"] !== instanceId) {
        response.writeHead(409).end();
        return;
      }
      response.writeHead(202).end(() => {
        setImmediate(() => {
          boundAddress = undefined;
          server.close();
        });
      });
      return;
    }

    const isCannbot = incoming.method === "POST" && pathname === "/v1/chat/completions";
    const isCcr = incoming.method === "POST" && CCR_PATHS.has(pathname);
    if (!isCannbot && !isCcr) {
      response.writeHead(404).end();
      return;
    }
    if (!secretsEqual(incoming.headers.authorization, options.localSecret)) {
      unauthorized(response);
      return;
    }

    try {
      const collected = await collectBody(incoming, maximumBodyBytes);
      if (isCcr) {
        let body: Buffer;
        try {
          body = rewriteClaudeModel(collected, options.models);
        } catch (error) {
          if (error instanceof UnsupportedModelError) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end('{"error":"unsupported_model"}');
            return;
          }
          if (error instanceof InvalidRequestError) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end('{"error":"invalid_request"}');
            return;
          }
          throw error;
        }
        const upstream = await makeCcrRequest(
          options,
          incoming.url ?? "/",
          incoming.headers,
          body
        );
        copyResponse(upstream, response);
        return;
      }

      let upstream = await makeUpstreamRequest(options, incoming.headers, collected);
      if (upstream.statusCode === 401 || upstream.statusCode === 403) {
        await drainResponse(upstream);
        await refreshOnce();
        upstream = await makeUpstreamRequest(options, incoming.headers, collected);
      }
      copyResponse(upstream, response);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end('{"error":"request_too_large"}');
        return;
      }
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end('{"error":"upstream_failure"}');
    }
  });

  return {
    instanceId,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Shim did not bind a TCP address"));
          return;
        }
        boundAddress = { host, port: address.port };
        resolve(boundAddress);
      });
    }),
    close: () => new Promise((resolve, reject) => {
      if (!server.listening) {
        boundAddress = undefined;
        resolve();
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else {
          boundAddress = undefined;
          resolve();
        }
      });
    }),
    address: () => boundAddress
  };
}
