import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function repoFiles() {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  return listed.status === 0 ? listed.stdout.split("\n").filter(Boolean).filter((f) => fsSync.existsSync(path.join(ROOT, f))) : [];
}

describe("quality: dependencies gate", () => {
  it("passes when package.json matches allowed-dependencies.json", async () => {
    const { dependencies } = await import("../../scripts/quality.mjs");
    const files = repoFiles();
    const result = dependencies(files);
    expect(result.passed).toBe(true);
  });

  it("fails when a new dependency is added without updating allowed list", async () => {
    const { dependencies } = await import("../../scripts/quality.mjs");
    const pkgPath = path.join(ROOT, "package.json");
    const original = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(original);
    pkg.dependencies["new-dep"] = "^1.0.0";
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    try {
      const files = repoFiles();
      const result = dependencies(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain("dependencies: new-dep@^1.0.0 not in allowed list");
    } finally {
      await fs.writeFile(pkgPath, original);
    }
  });

  it("fails when a lockfile entry has hasInstallScript but not in allowScripts", async () => {
    const { dependencies } = await import("../../scripts/quality.mjs");
    const lockPath = path.join(ROOT, "package-lock.json");
    const original = await fs.readFile(lockPath, "utf8");
    const lock = JSON.parse(original);
    lock.packages["node_modules/malicious-pkg"] = { version: "1.0.0", hasInstallScript: true };
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
    try {
      const files = repoFiles();
      const result = dependencies(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain("install script: malicious-pkg has install script but not in allowScripts");
    } finally {
      await fs.writeFile(lockPath, original);
    }
  });
});
