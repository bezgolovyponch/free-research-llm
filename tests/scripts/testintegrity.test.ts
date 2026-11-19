import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { checkTestIntegrity } from '../../scripts/quality.mjs';

describe('testIntegrity gate', () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
  });

  it('detects a changed expect line in a test file', async () => {
    const diff = `diff --git a/tests/research/example.test.ts b/tests/research/example.test.ts
--- a/tests/research/example.test.ts
+++ b/tests/research/example.test.ts
@@ -1,4 +1,4 @@
 import { describe, expect, it } from 'vitest';
 
 describe('example', () => {
-  it('passes', () => { expect(1 + 1).toBe(2); });
+  it('passes', () => { expect(1 + 1).toBe(3); });
 })`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in tests/research/example.test.ts:');
    expect(result.detail).toContain('expect(1 + 1).toBe(3)');
  });

  it('detects a removed line in a test file', async () => {
    const diff = `diff --git a/tests/research/example.test.ts b/tests/research/example.test.ts
--- a/tests/research/example.test.ts
+++ b/tests/research/example.test.ts
@@ -1,5 +1,4 @@
 import { describe, expect, it } from 'vitest';
 
 describe('example', () => {
-  it('old test', () => { expect(true).toBe(true); });
   it('new test', () => { expect(false).toBe(false); });
 })`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Removed line in tests/research/example.test.ts:');
    expect(result.detail).toContain('it(\'old test\'');
  });

  it('detects a changed line in a methods fixture', async () => {
    const diff = `diff --git a/tests/fixtures/methods/M1.txt b/tests/fixtures/methods/M1.txt
--- a/tests/fixtures/methods/M1.txt
+++ b/tests/fixtures/methods/M1.txt
@@ -1 +1 @@
-Electre Tri is a set of methods designed to sort alternatives evaluated on several criteria into ordered categories.
+Electre Tri is a set of methods designed to sort alternatives evaluated on several criteria into UNORDERED categories.`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in tests/fixtures/methods/M1.txt:');
    expect(result.detail).toContain('UNORDERED categories');
  });

  it('detects a changed line in scripts/quality.mjs', async () => {
    const diff = `diff --git a/scripts/quality.mjs b/scripts/quality.mjs
--- a/scripts/quality.mjs
+++ b/scripts/quality.mjs
@@ -1,3 +1,3 @@
-#!/usr/bin/env node
+#!/usr/bin/env node --experimental-strip-types
 import { spawnSync } from 'node:child_process';`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in scripts/quality.mjs:');
  });

  it('detects a changed line in scripts/zero-loss.mjs', async () => {
    const diff = `diff --git a/scripts/zero-loss.mjs b/scripts/zero-loss.mjs
--- a/scripts/zero-loss.mjs
+++ b/scripts/zero-loss.mjs
@@ -1,3 +1,3 @@
-#!/usr/bin/env node
+#!/usr/bin/env node --experimental-strip-types
 import fs from 'node:fs/promises';`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in scripts/zero-loss.mjs:');
  });

  it('detects a changed line in scripts/reference-set.mjs', async () => {
    const diff = `diff --git a/scripts/reference-set.mjs b/scripts/reference-set.mjs
--- a/scripts/reference-set.mjs
+++ b/scripts/reference-set.mjs
@@ -1,3 +1,3 @@
-#!/usr/bin/env node
+#!/usr/bin/env node --experimental-strip-types
 import fs from 'node:fs/promises';`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in scripts/reference-set.mjs:');
  });

  it('detects a changed line in tests/fixtures/reference/baseline.json', async () => {
    const diff = `diff --git a/tests/fixtures/reference/baseline.json b/tests/fixtures/reference/baseline.json
--- a/tests/fixtures/reference/baseline.json
+++ b/tests/fixtures/reference/baseline.json
@@ -1,3 +1,3 @@
-{
+{
 "recordedAt": "2026-11-19T00:00:00.000Z",`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in tests/fixtures/reference/baseline.json:');
  });

  it('passes for added test file (only additions)', async () => {
    const diff = `diff --git a/tests/research/new.test.ts b/tests/research/new.test.ts
--- /dev/null
+++ b/tests/research/new.test.ts
@@ -0,0 +1,5 @@
+import { describe, expect, it } from 'vitest';
+
+describe('new', () => {
+  it('passes', () => { expect(1 + 1).toBe(2); });
+})`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('no removed or changed lines in protected paths');
  });

  it('passes for added lines in existing test file', async () => {
    const diff = `diff --git a/tests/research/example.test.ts b/tests/research/example.test.ts
--- a/tests/research/example.test.ts
+++ b/tests/research/example.test.ts
@@ -1,4 +1,6 @@
 import { describe, expect, it } from 'vitest';
 
 describe('example', () => {
   it('passes', () => { expect(1 + 1).toBe(2); });
+  it('also passes', () => { expect(2 + 2).toBe(4); });
+  it('third test', () => { expect(3 + 3).toBe(6); });
 })`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('no removed or changed lines in protected paths');
  });

  it('passes when commit message has test-change line for the path', async () => {
    const diff = `diff --git a/tests/research/example.test.ts b/tests/research/example.test.ts
--- a/tests/research/example.test.ts
+++ b/tests/research/example.test.ts
@@ -1,4 +1,4 @@
 import { describe, expect, it } from 'vitest';
 
 describe('example', () => {
-  it('passes', () => { expect(1 + 1).toBe(2); });
+  it('passes', () => { expect(1 + 1).toBe(3); });
 })`;
    const commitMessages = ['test-change: tests/research/example.test.ts — updated expectation for new behavior'];
    const result = checkTestIntegrity(diff, commitMessages);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('allowed by test-change');
  });

  it('passes when commit message has test-change line for a methods fixture', async () => {
    const diff = `diff --git a/tests/fixtures/methods/M1.txt b/tests/fixtures/methods/M1.txt
--- a/tests/fixtures/methods/M1.txt
+++ b/tests/fixtures/methods/M1.txt
@@ -1 +1 @@
-Electre Tri is a set of methods designed to sort alternatives evaluated on several criteria into ordered categories.
+Electre Tri is a set of methods designed to sort alternatives evaluated on several criteria into UNORDERED categories.`;
    const commitMessages = ['test-change: tests/fixtures/methods/M1.txt — fixture updated to match new source'];
    const result = checkTestIntegrity(diff, commitMessages);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('allowed by test-change');
  });

  it('fails when test-change line does not match the changed path', async () => {
    const diff = `diff --git a/tests/research/example.test.ts b/tests/research/example.test.ts
--- a/tests/research/example.test.ts
+++ b/tests/research/example.test.ts
@@ -1,4 +1,4 @@
 import { describe, expect, it } from 'vitest';
 
 describe('example', () => {
-  it('passes', () => { expect(1 + 1).toBe(2); });
+  it('passes', () => { expect(1 + 1).toBe(3); });
 })`;
    const commitMessages = ['test-change: tests/research/other.test.ts — unrelated change'];
    const result = checkTestIntegrity(diff, commitMessages);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in tests/research/example.test.ts:');
  });

  it('prints every removed/changed line found', async () => {
    const diff = `diff --git a/tests/research/example.test.ts b/tests/research/example.test.ts
--- a/tests/research/example.test.ts
+++ b/tests/research/example.test.ts
@@ -1,6 +1,6 @@
 import { describe, expect, it } from 'vitest';

 describe('example', () => {
-  it('test 1', () => { expect(1).toBe(1); });
-  it('test 2', () => { expect(2).toBe(2); });
+  it('test 1', () => { expect(1).toBe(2); });
+  it('test 2', () => { expect(2).toBe(3); });
 })`;
    const result = checkTestIntegrity(diff, []);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Changed line in tests/research/example.test.ts:');
    expect(result.detail).toContain('expect(1).toBe(2)');
    expect(result.detail).toContain('expect(2).toBe(3)');
  });
});
