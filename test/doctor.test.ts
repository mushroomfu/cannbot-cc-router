import assert from "node:assert/strict";
import test from "node:test";

import { runDoctor, type DoctorDependencies } from "../src/doctor.js";

function healthyDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    nodeVersion: () => "24.14.0",
    executable: async () => true,
    ccrVersion: async () => ({ major: 2, version: "2.0.0" }),
    credentials: async () => undefined,
    ccrConfig: async () => undefined,
    proxy: async () => "http://127.0.0.1:10808",
    upstream: async () => true,
    shim: async () => true,
    ccr: async () => true,
    ...overrides
  };
}

test("doctor reports every required boundary without secrets", async () => {
  const report = await runDoctor(healthyDependencies());
  assert.deepEqual(report.checks.map((check) => check.name), [
    "node",
    "cannbot",
    "ccr",
    "claude",
    "ccr-version",
    "credentials",
    "ccr-config",
    "proxy",
    "cannbot-upstream",
    "shim",
    "ccr-service"
  ]);
  assert.equal(report.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /access-secret|virtual-secret/);
});

test("stopped local services are warnings, not doctor failures", async () => {
  const report = await runDoctor(healthyDependencies({
    shim: async () => false,
    ccr: async () => false
  }));
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.slice(-2).map((check) => check.status), ["warn", "warn"]);
});

test("missing runtime and unreachable upstream fail doctor", async () => {
  const report = await runDoctor(healthyDependencies({
    executable: async (name) => name !== "ccr",
    upstream: async () => false
  }));
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.filter((check) => check.status === "fail").map((check) => check.name),
    ["ccr", "cannbot-upstream"]
  );
});

test("unsupported CCR versions fail doctor", async () => {
  const report = await runDoctor(healthyDependencies({
    ccrVersion: async () => { throw new Error("unsupported"); }
  }));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "ccr-version")?.status, "fail");
});

test("credential failures direct users to cannbot connect", async () => {
  const report = await runDoctor(healthyDependencies({
    credentials: async () => {
      throw new Error("missing virtual key");
    }
  }));

  assert.deepEqual(
    report.checks.find((check) => check.name === "credentials"),
    {
      name: "credentials",
      status: "fail",
      detail: "check failed",
      action: "Run `cannbot connect`"
    }
  );
});
