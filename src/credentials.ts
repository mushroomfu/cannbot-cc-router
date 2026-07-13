import { access, readFile } from "node:fs/promises";

import type { CannbotCredentials, ResolvedPaths } from "./types.js";

export type CredentialsErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "VIRTUAL_KEY_MISSING";

export class CredentialsError extends Error {
  constructor(
    public readonly code: CredentialsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CredentialsError";
  }
}

async function parseJsonFile(
  path: string,
  missingCode: CredentialsErrorCode,
  invalidCode: CredentialsErrorCode,
  label: string
): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CredentialsError(missingCode, `${label} file was not found: ${path}`);
    }
    throw error;
  }

  try {
    const value: unknown = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CredentialsError(invalidCode, `${label} file is not valid JSON: ${path}`);
  }
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return undefined;
}

export async function readCredentials(
  paths: ResolvedPaths
): Promise<CannbotCredentials> {
  const authPath = await firstExisting(paths.openCodeAuthCandidates);
  if (!authPath) {
    throw new CredentialsError(
      "AUTH_MISSING",
      `OpenCode authentication file was not found in: ${paths.openCodeAuthCandidates.join(", ")}`
    );
  }
  const auth = await parseJsonFile(
    authPath,
    "AUTH_MISSING",
    "AUTH_INVALID",
    "OpenCode authentication"
  );
  const virtualKeyEntry = auth["cannbot-vk"];
  const virtualKey =
    virtualKeyEntry && typeof virtualKeyEntry === "object"
      ? (virtualKeyEntry as Record<string, unknown>).key
      : undefined;
  if (typeof virtualKey !== "string" || virtualKey.trim() === "") {
    throw new CredentialsError(
      "VIRTUAL_KEY_MISSING",
      "Cannbot virtual key is missing; run `cannbot connect`"
    );
  }

  return { virtualKey };
}
