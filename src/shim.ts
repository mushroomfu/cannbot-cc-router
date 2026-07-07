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

function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  credentials: CannbotCredentials,
  body: Buffer
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === "host" ||
      lower === "authorization" ||
      lower === "x-api-vkey" ||
      lower === "content-length"
    ) continue;
    headers[lower] = value;
  }
  headers.authorization = `Bearer ${credentials.accessToken}`;
  headers["x-api-vkey"] = credentials.virtualKey;
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
    if (incoming.method === "GET" && incoming.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", instanceId, pid: process.pid }));
      return;
    }

    if (incoming.method === "POST" && incoming.url === "/shutdown") {
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

    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    if (!secretsEqual(incoming.headers.authorization, options.localSecret)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }

    try {
      const body = await collectBody(incoming, maximumBodyBytes);
      let upstream = await makeUpstreamRequest(options, incoming.headers, body);
      if (upstream.statusCode === 401 || upstream.statusCode === 403) {
        await drainResponse(upstream);
        await refreshOnce();
        upstream = await makeUpstreamRequest(options, incoming.headers, body);
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
      response.end(JSON.stringify({ error: "upstream_failure" }));
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
