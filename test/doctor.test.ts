import assert from "node:assert/strict";
import test from "node:test";

import { runDoctor, type DoctorDependencies } from "../src/doctor.js";

function healthyDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    nodeVersion: () => "24.14.0",
    executable: async () => true,
    ccrVersion: async () => ({ major: 3, version: "3.0.6" }),
    credentials: async () => undefined,
    projectConfig: async () => undefined,
    proxy: async () => "http://127.0.0.1:10808",
    upstream: async () => true,
    ...overrides
  };
}

test("doctor checks only private-launch prerequisites without exposing secrets", async () => {
  const report = await runDoctor(healthyDependencies());
  assert.deepEqual(report.checks.map((check) => check.name), [
    "node",
    "cannbot",
    "claude",
    "ccr-version",
    "credentials",
    "project-config",
    "proxy",
    "cannbot-upstream"
  ]);
  assert.equal(report.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /access-secret|virtual-secret/);
});

test("missing Claude and unreachable upstream fail doctor", async () => {
  const report = await runDoctor(healthyDependencies({
    executable: async (name) => name !== "claude",
    upstream: async () => false
  }));
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.filter((check) => check.status === "fail").map((check) => check.name),
    ["claude", "cannbot-upstream"]
  );
});

test("unsupported bundled CCR and credential failures provide actions", async () => {
  const report = await runDoctor(healthyDependencies({
    ccrVersion: async () => { throw new Error("unsupported"); },
    credentials: async () => { throw new Error("missing virtual key"); }
  }));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "ccr-version")?.status, "fail");
  assert.deepEqual(report.checks.find((check) => check.name === "credentials"), {
    name: "credentials",
    status: "fail",
    detail: "check failed",
    action: "Run `cannbot connect`"
  });
});
