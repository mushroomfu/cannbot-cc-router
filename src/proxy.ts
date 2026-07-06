import type { Agent } from "node:http";

import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:"
]);

function validateProxyUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Invalid proxy URL: ${value}`);
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  return value;
}

function splitNoProxy(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bypassesProxy(url: URL, value: string | undefined): boolean {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawEntry of splitNoProxy(value)) {
    if (rawEntry === "*") return true;
    const entry = rawEntry.toLowerCase();
    const separator = entry.lastIndexOf(":");
    const hasPort = separator > 0 && /^\d+$/.test(entry.slice(separator + 1));
    const entryHost = (hasPort ? entry.slice(0, separator) : entry).replace(/^\./, "");
    const entryPort = hasPort ? entry.slice(separator + 1) : undefined;
    const hostMatches = hostname === entryHost || hostname.endsWith(`.${entryHost}`);
    if (hostMatches && (!entryPort || entryPort === port)) return true;
  }
  return false;
}

export function mergeNoProxy(value: string | undefined): string {
  const entries = splitNoProxy(value);
  for (const loopback of ["localhost", "127.0.0.1"]) {
    if (!entries.some((entry) => entry.toLowerCase() === loopback)) entries.push(loopback);
  }
  return entries.join(",");
}

export function childProxyEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const copy = { ...env };
  const merged = mergeNoProxy([env.NO_PROXY, env.no_proxy].filter(Boolean).join(","));
  copy.NO_PROXY = merged;
  copy.no_proxy = merged;
  return copy;
}

export function selectProxy(
  target: string,
  mode: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (mode === "direct") return "";
  if (mode !== "auto") return validateProxyUrl(mode);

  const url = new URL(target);
  const noProxy = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(",");
  if (bypassesProxy(url, noProxy)) return "";

  const candidates = url.protocol === "https:"
    ? [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
    : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
  const selected = candidates.find((value) => typeof value === "string" && value !== "");
  return selected ? validateProxyUrl(selected) : "";
}

export function createProxyAgent(proxyUrl: string): Agent | undefined {
  if (!proxyUrl) return undefined;
  const protocol = new URL(validateProxyUrl(proxyUrl)).protocol;
  if (protocol === "http:" || protocol === "https:") {
    return new HttpsProxyAgent(proxyUrl);
  }
  return new SocksProxyAgent(proxyUrl);
}
