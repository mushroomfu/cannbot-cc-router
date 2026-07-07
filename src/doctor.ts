export type DiagnosticStatus = "pass" | "warn" | "fail";

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
  executable(name: "cannbot" | "ccr" | "claude"): Promise<boolean>;
  credentials(): Promise<void>;
  ccrConfig(): Promise<void>;
  proxy(): Promise<string>;
  upstream(): Promise<boolean>;
  shim(): Promise<boolean>;
  ccr(): Promise<boolean>;
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
  const major = Number.parseInt(dependencies.nodeVersion().split(".")[0] ?? "0", 10);
  const checks: DiagnosticCheck[] = [{
    name: "node",
    status: major >= 20 ? "pass" : "fail",
    detail: `Node.js ${dependencies.nodeVersion()}`,
    ...(major >= 20 ? {} : { action: "Install Node.js 20 or newer" })
  }];

  for (const name of ["cannbot", "ccr", "claude"] as const) {
    const available = await dependencies.executable(name);
    checks.push({
      name,
      status: available ? "pass" : "fail",
      detail: available ? `${name} is available` : `${name} is missing`,
      ...(available ? {} : { action: `Install ${name}` })
    });
  }

  checks.push(await checked(
    "credentials",
    dependencies.credentials,
    "Cannbot credentials are available",
    "Run `cannbot auth login` and `cannbot connect`"
  ));
  checks.push(await checked(
    "ccr-config",
    dependencies.ccrConfig,
    "CCR configuration is valid",
    "Run `cannbot-cc init`"
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
      action: "Check HTTPS_PROXY, ALL_PROXY, or use --proxy direct"
    });
  }

  const upstream = await dependencies.upstream();
  checks.push({
    name: "cannbot-upstream",
    status: upstream ? "pass" : "fail",
    detail: upstream ? "Cannbot model list is reachable" : "Cannbot model list is unreachable",
    ...(upstream ? {} : { action: "Check Shadowsocks and Cannbot login" })
  });

  for (const [name, active] of [
    ["shim", await dependencies.shim()],
    ["ccr-service", await dependencies.ccr()]
  ] as const) {
    checks.push({
      name,
      status: active ? "pass" : "warn",
      detail: active ? `${name} is running` : `${name} is stopped`,
      ...(active ? {} : { action: "Run `cannbot-cc start`" })
    });
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks
  };
}
