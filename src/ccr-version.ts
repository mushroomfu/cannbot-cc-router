export type CcrMajorVersion = 3;

export interface DetectedCcrVersion {
  major: CcrMajorVersion;
  version: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSupportedCcrVersion(version: string): DetectedCcrVersion {
  const match = SEMVER.exec(version);
  if (!match) throw new Error("Unable to determine CCR version");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 3 && minor === 0 && patch >= 0 && patch <= 6) {
    return { major: 3, version };
  }
  throw new Error(
    `Unsupported CCR version ${version}; supported npm CLI versions are CCR 3.0.0 through 3.0.6`
  );
}
