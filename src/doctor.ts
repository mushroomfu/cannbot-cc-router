import type { DetectedCcrVersion } from "./ccr-version.js";

export type DiagnosticStatus = "pass" | "fail";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  detail: string;
  action?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DiagnosticCheck[];
}

export interface DoctorDependencies {
  nodeVersion(): string;
  executable(name: "cannbot" | "claude"): Promise<boolean>;
  ccrVersion(): Promise<DetectedCcrVersion>;
  credentials(): Promise<void>;
  projectConfig(): Promise<void>;
  proxy(): Promise<string>;
  upstream(): Promise<boolean>;
}

async function checked(
  name: string,
  operation: () => Promise<void>,
  successDetail: string,
  action: string
): Promise<DiagnosticCheck> {
  try {
    await operation();
    return { name, status: "pass", detail: successDetail };
  } catch {
    return { name, status: "fail", detail: "check failed", action };
  }
}

export async function runDoctor(dependencies: DoctorDependencies): Promise<DoctorReport> {
  const version = dependencies.nodeVersion();
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  const checks: DiagnosticCheck[] = [{
    name: "node",
    status: major >= 22 ? "pass" : "fail",
    detail: `Node.js ${version}`,
    ...(major >= 22 ? {} : { action: "Install Node.js 22 or newer" })
  }];

  for (const name of ["cannbot", "claude"] as const) {
    const available = await dependencies.executable(name);
    checks.push({
      name,
      status: available ? "pass" : "fail",
      detail: available ? `${name} is available` : `${name} is missing`,
      ...(available ? {} : { action: `Install ${name}` })
    });
  }

  try {
    const ccr = await dependencies.ccrVersion();
    if (ccr.version !== "3.0.6") throw new Error("unsupported bundled CCR");
    checks.push({ name: "ccr-version", status: "pass", detail: "Bundled CCR CLI 3.0.6" });
  } catch {
    checks.push({
      name: "ccr-version",
      status: "fail",
      detail: "Bundled CCR CLI is unavailable or not 3.0.6",
      action: "Run npm install in cannbot-cc-router"
    });
  }

  checks.push(await checked(
    "credentials",
    dependencies.credentials,
    "Cannbot credentials are available",
    "Run `cannbot connect`"
  ));
  checks.push(await checked(
    "project-config",
    dependencies.projectConfig,
    "Project configuration is readable",
    "Run `cannbot-cc code` to create project configuration"
  ));

  try {
    const selected = await dependencies.proxy();
    checks.push({
      name: "proxy",
      status: "pass",
      detail: selected ? `proxy selected: ${new URL(selected).host}` : "direct connection selected"
    });
  } catch {
    checks.push({
      name: "proxy",
      status: "fail",
      detail: "proxy configuration is invalid",
      action: "Check standard proxy environment variables or project proxy mode"
    });
  }

  const upstream = await dependencies.upstream();
  checks.push({
    name: "cannbot-upstream",
    status: upstream ? "pass" : "fail",
    detail: upstream ? "Cannbot model list is reachable" : "Cannbot model list is unreachable",
    ...(upstream ? {} : { action: "Check proxy settings and Cannbot login" })
  });

  return { ok: !checks.some((check) => check.status === "fail"), checks };
}
