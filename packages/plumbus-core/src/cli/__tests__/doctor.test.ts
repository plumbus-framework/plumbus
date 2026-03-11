import { describe, expect, it } from "vitest";
import { checkNodeVersion, checkPostgreSQL, checkRedis, checkTypeScript, runDoctorChecks, runFullDoctorChecks } from "../commands/doctor.js";

describe("plumbus doctor", () => {
  it("checks Node.js version", () => {
    const check = checkNodeVersion();
    expect(check.name).toBe("node");
    // We're running on Node 20+, should pass
    expect(check.status).toBe("ok");
    expect(check.message).toContain("Node.js");
  });

  it("returns all expected checks", () => {
    const checks = runDoctorChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("typescript");
    expect(names).toContain("package.json");
    expect(names).toContain("config");
    expect(names).toContain("app-structure");
  });

  it("detects TypeScript availability", () => {
    const check = checkTypeScript();
    expect(check.name).toBe("typescript");
    // TypeScript is installed in our dev deps
    expect(["ok", "fail"]).toContain(check.status);
  });

  it("returns structured check results", () => {
    const checks = runDoctorChecks();
    for (const check of checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("message");
      expect(["ok", "warn", "fail"]).toContain(check.status);
    }
  });

  it("checkPostgreSQL returns a structured check result", async () => {
    const check = await checkPostgreSQL();
    expect(check.name).toBe("postgresql");
    expect(["ok", "warn", "fail"]).toContain(check.status);
    expect(check.message).toBeTruthy();
  });

  it("checkRedis returns a structured check result", async () => {
    const check = await checkRedis();
    expect(check.name).toBe("redis");
    expect(["ok", "warn", "fail"]).toContain(check.status);
    expect(check.message).toBeTruthy();
  });

  it("runFullDoctorChecks includes connectivity checks", async () => {
    const checks = await runFullDoctorChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("postgresql");
    expect(names).toContain("redis");
    expect(checks.length).toBeGreaterThan(runDoctorChecks().length);
  });
});
