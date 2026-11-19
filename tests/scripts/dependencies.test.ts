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

async function setupDependenciesTest() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deps-test-'));
  const fixturesDir = path.join(tmp, 'tests', 'fixtures', 'security');
  await fs.mkdir(fixturesDir, { recursive: true });

  const allowedPath = path.join(ROOT, 'tests', 'fixtures', 'security', 'allowed-dependencies.json');
  const pkgPath = path.join(ROOT, 'package.json');
  const lockPath = path.join(ROOT, 'package-lock.json');

  await fs.copyFile(allowedPath, path.join(fixturesDir, 'allowed-dependencies.json'));
  await fs.copyFile(pkgPath, path.join(tmp, 'package.json'));
  await fs.copyFile(lockPath, path.join(tmp, 'package-lock.json'));

  return tmp;
}

describe("quality: dependencies gate", () => {
  it("passes when package.json matches allowed-dependencies.json", async () => {
    const { dependencies } = await import("../../scripts/quality.mjs");
    const tmp = await setupDependenciesTest();
    const files = ['package.json', 'package-lock.json', 'tests/fixtures/security/allowed-dependencies.json'];
    const result = dependencies(files, tmp);
    expect(result.passed).toBe(true);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fails when a new dependency is added without updating allowed list", async () => {
    const { dependencies } = await import("../../scripts/quality.mjs");
    const tmp = await setupDependenciesTest();
    const pkgPath = path.join(tmp, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    pkg.dependencies["new-dep"] = "^1.0.0";
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    const files = ['package.json', 'package-lock.json', 'tests/fixtures/security/allowed-dependencies.json'];
    const result = dependencies(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("dependencies: new-dep@^1.0.0 not in allowed list");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fails when a lockfile entry has hasInstallScript but not in allowScripts", async () => {
    const { dependencies } = await import("../../scripts/quality.mjs");
    const tmp = await setupDependenciesTest();
    const lockPath = path.join(tmp, "package-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    lock.packages["node_modules/malicious-pkg"] = { version: "1.0.0", hasInstallScript: true };
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
    const files = ['package.json', 'package-lock.json', 'tests/fixtures/security/allowed-dependencies.json'];
    const result = dependencies(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("install script: malicious-pkg has install script but not in allowScripts");
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
