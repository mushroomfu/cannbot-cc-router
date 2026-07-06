function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(input: string, knownSecrets: string[] = []): string {
  let output = input;
  for (const secret of knownSecrets) {
    if (secret.trim() === "") continue;
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }

  output = output.replace(
    /(\bAuthorization\s*:\s*Bearer\s+)[^\s,;]+/gi,
    "$1[REDACTED]"
  );
  output = output.replace(
    /(\bx-api-vkey\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[REDACTED]"
  );
  output = output.replace(
    /("(?:accessToken|refreshToken|apiKey|authorization|x-api-vkey)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"'
  );
  return output;
}
