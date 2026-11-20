import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { verdict, acceptanceSummaryOf, hardIdsOf, runOutcome, verdictInvariants, chosenOptionId, scoreOf } from '../../src/research/verdict.mjs';
import { purposeChecks } from '../../src/research/acceptance.mjs';
import { isUmbrella } from '../../src/research/concept.mjs';
import { kindCluster } from '../../src/research/checklist.mjs';

function fold(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

describe('rebuild-check: acceptance clause parser', () => {
  it('parses realistic stored verdict string', () => {
    const stored = 'VERDICT: PROVISIONAL (acceptance: 0 of 15 confirmed · 4 to confirm (open: ...) · 14 rejected · 6 not read)';
    const parsed = {
      confirmed: 0,
      toConfirm: 4,
      rejected: 14,
      notRead: 6
    };
    const matchConfirmed = stored.match(/(\d+)\s+of\s+\d+\s+confirmed/i);
    const matchToConfirm = stored.match(/(\d+)\s+to\s+confirm/i);
    const matchRejected = stored.match(/(\d+)\s+rejected/i);
    const matchNotRead = stored.match(/(\d+)\s+not\s+read/i);
    expect(Number(matchConfirmed?.[1] ?? 0)).toBe(parsed.confirmed);
    expect(Number(matchToConfirm?.[1] ?? 0)).toBe(parsed.toConfirm);
    expect(Number(matchRejected?.[1] ?? 0)).toBe(parsed.rejected);
    expect(Number(matchNotRead?.[1] ?? 0)).toBe(parsed.notRead);
  });
});

describe('rebuild-check: verdict functions', () => {
  const sampleItems = [
    { url: 'https://a.example.org/1', title: 'Item 1', checks: [{ id: 'quality|Good?', answer: 'yes', quote: 'q1', hard: true, clause: 'quality' }], live: true, listing: true, inRange: true, purpose: [] },
    { url: 'https://a.example.org/2', title: 'Item 2', checks: [{ id: 'quality|Good?', answer: 'no', quote: '', hard: true, clause: 'quality' }], live: true, listing: true, inRange: false, purpose: [] },
    { url: 'https://a.example.org/3', title: 'Item 3', checks: [{ id: 'quality|Good?', answer: 'unknown', quote: '', hard: true, clause: 'quality' }], live: true, listing: true, inRange: true, purpose: [] },
    { url: 'https://a.example.org/4', title: 'Item 4', checks: [], live: true, listing: true, inRange: true, purpose: [] },
  ];
  const checklist = [{ clause: 'quality', items: [{ question: 'Good?', hard: true }] }];
  const kind = { label: 'item', terms: ['item'], members: [] };

  it('computes verdict tiers correctly', () => {
    const result = verdict(sampleItems, { itemCount: 4 }, checklist, kind);
    expect(result.tiers.confirmed).toBe(1);
    expect(result.tiers.toConfirm).toBe(1);
    expect(result.tiers.rejected).toBe(1);
    expect(result.tiers.notJudged).toBe(1);
    expect(result.validCount).toBe(1);
    expect(result.asked).toBe(4);
  });

  it('acceptanceSummaryOf returns summary from acceptanceResult', () => {
    const project = {
      acceptance: { itemCount: 4 },
      checklist,
      decisionModel: { kind },
      acceptanceResult: { verdict: { summary: '1 of 4 confirmed · 1 to confirm · 1 rejected · 1 not read' } }
    };
    expect(acceptanceSummaryOf(project)).toBe('1 of 4 confirmed · 1 to confirm · 1 rejected · 1 not read');
  });

  it('hardIdsOf returns correct hard check ids for non-umbrella kind', () => {
    const ids = hardIdsOf(checklist, kind);
    expect(ids).toContain('quality|Good?');
    expect(ids).not.toContain('kind|');
  });

  it('hardIdsOf returns kind check id for umbrella kind', () => {
    const umbrellaKind = { label: 'vehicle', terms: ['vehicle'], members: [{ label: 'car', terms: ['car'] }, { label: 'truck', terms: ['truck'] }] };
    expect(isUmbrella(umbrellaKind)).toBe(true);
    const ids = hardIdsOf(checklist, umbrellaKind);
    expect(ids).toContain('quality|Good?');
    const kindId = kindCluster(umbrellaKind).items[0].question;
    expect(ids).toContain('kind|' + kindId);
  });

  it('runOutcome returns short when confirmed < asked', () => {
    const project = {
      phase: 'done',
      acceptanceResult: { totalAsked: 4, validCount: 1 }
    };
    expect(runOutcome(project)).toEqual({ state: 'short', confirmed: 1, asked: 4 });
  });

  it('runOutcome returns met when confirmed >= asked', () => {
    const project = {
      phase: 'done',
      acceptanceResult: { totalAsked: 2, validCount: 2 }
    };
    expect(runOutcome(project)).toEqual({ state: 'met', confirmed: 2, asked: 2 });
  });

  it('verdictInvariants detects validCount mismatch', () => {
    const project = {
      acceptance: { itemCount: 2 },
      checklist: [{ clause: 'q', items: [{ question: 'Good?', hard: true }] }],
      decisionModel: { kind: { label: 'item', terms: ['item'], members: [] } },
      acceptanceResult: {
        items: [
          { url: 'https://a.example.org/1', checks: [{ id: 'q|Good?', answer: 'yes', hard: true, clause: 'q' }], tier: 'confirmed', live: true, listing: true, inRange: true, purpose: [] },
          { url: 'https://a.example.org/2', checks: [{ id: 'q|Good?', answer: 'no', hard: true, clause: 'q' }], tier: 'rejected', live: true, listing: true, inRange: false, purpose: [] }
        ],
        validCount: 0,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [{ id: 'count', value: 0.5, passed: false }],
        score: 0.5
      }
    };
    const violations = verdictInvariants(project, { memo: false });
    expect(violations.some(v => v.includes('validCount mismatch'))).toBe(true);
  });

  it('verdictInvariants detects score mismatch', () => {
    const project = {
      acceptance: { itemCount: 1 },
      checklist: [{ clause: 'q', items: [{ question: 'Good?', hard: true }] }],
      decisionModel: { kind: { label: 'item', terms: ['item'], members: [] } },
      acceptanceResult: {
        items: [
          { url: 'https://a.example.org/1', checks: [{ id: 'q|Good?', answer: 'yes', hard: true, clause: 'q' }], tier: 'confirmed', live: true, listing: true, inRange: true, purpose: [] }
        ],
        validCount: 1,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 0, notJudged: 0 } },
        checks: [
          { id: 'count', value: 1, passed: true },
          { id: 'checklist-q|Good?', value: 1, passed: true }
        ],
        score: 0.5
      }
    };
    const violations = verdictInvariants(project, { memo: false });
    expect(violations.some(v => v.includes('score mismatch'))).toBe(true);
  });

  it('chosenOptionId matches exact option', () => {
    const options = [{ id: 'O1', option: 'Buy it' }, { id: 'O2', option: 'Sell it' }];
    expect(chosenOptionId(options, 'Buy it')).toEqual({ id: 'O1', note: null });
    expect(chosenOptionId(options, 'Sell it')).toEqual({ id: 'O2', note: null });
  });

  it('chosenOptionId returns not among options for unknown text', () => {
    const options = [{ id: 'O1', option: 'Buy it' }];
    expect(chosenOptionId(options, 'Hold it')).toEqual({ id: null, note: 'not among the options' });
  });

  it('chosenOptionId returns ambiguous for duplicate options', () => {
    const options = [{ id: 'O1', option: 'Buy it' }, { id: 'O2', option: 'Buy it' }];
    expect(chosenOptionId(options, 'Buy it')).toEqual({ id: null, note: 'ambiguous' });
  });

  it('purposeChecks extracts name lists from question with commas', () => {
    const project = {
      question: 'Find Acme Corp, Beta Inc',
      decisionModel: { kind: null },
      brief: { kind: null }
    };
    const checks = purposeChecks(project);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].id).toBe('purpose-names-1');
    expect(checks[0].names).toContain('Acme Corp');
    expect(checks[0].names).toContain('Beta Inc');
  });

  it('purposeChecks returns kind check for umbrella kind', () => {
    const project = {
      question: 'Find vehicles',
      decisionModel: { kind: { label: 'vehicle', terms: ['vehicle'], members: [{ label: 'car', terms: ['car'] }, { label: 'truck', terms: ['truck'] }] } },
      brief: { kind: null }
    };
    const checks = purposeChecks(project);
    const kindCheck = checks.find(c => c.id === 'purpose-kind');
    expect(kindCheck).toBeDefined();
    expect(kindCheck?.type).toBe('kind');
    expect(kindCheck?.terms).toContain('vehicle');
    expect(kindCheck?.terms).toContain('car');
    expect(kindCheck?.terms).toContain('truck');
  });
});

describe('rebuild-check: CLI integration', () => {
  let testDir;
  let projectsDir;

  beforeEach(async () => {
    testDir = await mkdir(join(tmpdir(), 'frl-rebuild-test-' + Date.now()), { recursive: true });
    projectsDir = join(testDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeProject(id, project) {
    await writeFile(join(projectsDir, `${id}.json`), JSON.stringify(project, null, 2));
  }

  function runRebuildCheck(only = '') {
    const args = ['scripts/rebuild-check.mjs', 'run', testDir];
    if (only) args.push('--only', only);
    return spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  }

  const baseItem = (url, answer, tier) => ({
    url,
    checks: [{ id: 'quality|Good?', answer, hard: true, clause: 'quality' }],
    tier,
    live: true,
    listing: true,
    inRange: answer === 'yes',
    purpose: []
  });

  const baseProject = {
    question: 'Test project',
    phase: 'done',
    acceptance: { itemCount: 2 },
    checklist: [{ clause: 'quality', items: [{ question: 'Good?', hard: true }] }],
    decisionModel: { kind: { label: 'item', terms: ['item'], members: [] } },
    acceptanceResult: {
      items: [
        baseItem('https://a.example.org/1', 'yes', 'confirmed'),
        baseItem('https://a.example.org/2', 'no', 'rejected')
      ],
      validCount: 1,
      totalAsked: 2,
      verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
      checks: [
        { id: 'count', value: 0.5, passed: false },
        { id: 'checklist-quality|Good?', value: 0.5, passed: false }
      ],
      score: 0.5
    },
    report: {
      verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)',
      options: [{ id: 'O1', option: 'Buy it' }],
      chosenOption: 'O1',
      chosenOptionNote: null
    },
    runOutcome: { state: 'short', confirmed: 1, asked: 2 }
  };

  it('OK project passes with no drifts', async () => {
    const project = { ...baseProject, id: 'ok-project' };
    await writeProject('ok-project', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok-project | item | OK acceptance');
    expect(result.stdout).toContain('ok-project | item | OK verdict');
    expect(result.stdout).toContain('ok-project | item | OK runOutcome');
    expect(result.stdout).toContain('ok-project | item | OK chosenOption');
    expect(result.stdout).toContain('ok-project | item | SKIP purposeChecks: no purpose criteria on an item path');
    expect(result.stdout).toContain('rebuild-check: PASS (1 projects,');
  });

  it('SKIP runOutcome when not stored', async () => {
    const project = { ...baseProject, id: 'no-run-outcome' };
    delete project.runOutcome;
    await writeProject('no-run-outcome', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no-run-outcome | item | SKIP runOutcome: not stored (derived value)');
    expect(result.stdout).not.toContain('no-run-outcome | item | OK runOutcome');
  });

  it('DRIFT when a stored purpose criterion is no longer rebuilt', async () => {
    const project = {
      ...baseProject,
      id: 'purpose-drift',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'purpose-kind', value: 1, passed: true }
        ]
      }
    };
    await writeProject('purpose-drift', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('purpose-drift | item | DRIFT purpose.purpose-kind: stored present rebuilt missing');
  });

  it('DRIFT on acceptance counts detected', async () => {
    const project = {
      ...baseProject,
      id: 'drift-acceptance',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('drift-acceptance', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('DRIFT acceptance.confirmed: stored 1 rebuilt 2');
    expect(result.stdout).toContain('DRIFT acceptance.rejected: stored 1 rebuilt 0');
    expect(result.stdout).toContain('DRIFT verdict.confirmed: stored 1 rebuilt 2');
    expect(result.stdout).toContain('DRIFT verdict.rejected: stored 1 rebuilt 0');
    expect(result.stdout).toContain('rebuild-check: FAIL (1 drifts;');
  });

  it('DRIFT on chosenOption detected', async () => {
    const project = {
      ...baseProject,
      id: 'drift-chosen',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed')
        ],
        validCount: 1,
        totalAsked: 1,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 0, notJudged: 0 } },
        checks: [
          { id: 'count', value: 1, passed: true },
          { id: 'checklist-quality|Good?', value: 1, passed: true }
        ],
        score: 1
      },
      report: {
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 1 confirmed · 0 to confirm · 0 rejected · 0 not read)',
        options: [{ id: 'O1', option: 'Buy it' }, { id: 'O2', option: 'Sell it' }],
        chosenOption: 'O9',
        chosenOptionNote: null
      },
      runOutcome: { state: 'met', confirmed: 1, asked: 1 }
    };
    await writeProject('drift-chosen', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('DRIFT chosenOption: id O9 not among the option ids');
    expect(result.stdout).toContain('rebuild-check: FAIL (1 drifts;');
  });

  it('SKIP when missing checklist', async () => {
    const project = {
      ...baseProject,
      id: 'skip-checklist',
      checklist: null,
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed')
        ],
        validCount: 1,
        totalAsked: 1,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 0, notJudged: 0 } },
        checks: [
          { id: 'count', value: 1, passed: true }
        ],
        score: 1
      },
      report: {
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 1 confirmed · 0 to confirm · 0 rejected · 0 not read)',
        options: [{ id: 'O1', option: 'Buy it' }],
        chosenOption: 'O1',
        chosenOptionNote: null
      },
      runOutcome: { state: 'met', confirmed: 1, asked: 1 }
    };
    await writeProject('skip-checklist', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skip-checklist | item | SKIP acceptance: missing items, checklist, or spec');
    expect(result.stdout).toContain('rebuild-check: PASS (1 projects,');
  });

  it('INVARIANT case prints invariant violations (score mismatch)', async () => {
    const project = {
      ...baseProject,
      id: 'invariant-case',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'no', 'rejected')
        ],
        validCount: 1,
        totalAsked: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.99
      },
      report: {
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)',
        options: [{ id: 'O1', option: 'Buy it' }],
        chosenOption: 'O1',
        chosenOptionNote: null
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('invariant-case', project);
    const result = runRebuildCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('invariant-case | item | INVARIANT');
    expect(result.stdout).toContain('score mismatch');
    expect(result.stdout).toContain('rebuild-check: PASS (1 projects,');
  });

  it('--only filters by project id prefix', async () => {
    const project1 = {
      ...baseProject,
      id: 'b2f5b7-abc',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed')
        ],
        validCount: 1,
        totalAsked: 1,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 0, notJudged: 0 } },
        checks: [
          { id: 'count', value: 1, passed: true },
          { id: 'checklist-quality|Good?', value: 1, passed: true }
        ],
        score: 1
      },
      report: {
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 1 confirmed · 0 to confirm · 0 rejected · 0 not read)',
        options: [{ id: 'O1', option: 'Buy' }],
        chosenOption: 'O1',
        chosenOptionNote: null
      },
      runOutcome: { state: 'met', confirmed: 1, asked: 1 }
    };
    const project2 = {
      ...baseProject,
      id: '0c750f-xyz',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/2', 'no', 'rejected')
        ],
        validCount: 0,
        totalAsked: 1,
        verdict: { tiers: { confirmed: 0, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0, passed: false },
          { id: 'checklist-quality|Good?', value: 0, passed: false }
        ],
        score: 0
      },
      report: {
        verdict: 'VERDICT: PROVISIONAL (acceptance: 0 of 1 confirmed · 0 to confirm · 1 rejected · 0 not read)',
        options: [{ id: 'O1', option: 'Buy' }],
        chosenOption: 'O1',
        chosenOptionNote: null
      },
      runOutcome: { state: 'short', confirmed: 0, asked: 1 }
    };
    await writeProject('b2f5b7-abc', project1);
    await writeProject('0c750f-xyz', project2);

    const result1 = runRebuildCheck('b2f5b7');
    expect(result1.status).toBe(0);
    expect(result1.stdout).toContain('b2f5b7-abc');
    expect(result1.stdout).not.toContain('0c750f-xyz');

    const result2 = runRebuildCheck('0c750f');
    expect(result2.status).toBe(0);
    expect(result2.stdout).toContain('0c750f-xyz');
    expect(result2.stdout).not.toContain('b2f5b7-abc');

    const result3 = runRebuildCheck('b2f5b7,0c750f');
    expect(result3.status).toBe(0);
    expect(result3.stdout).toContain('b2f5b7-abc');
    expect(result3.stdout).toContain('0c750f-xyz');
  });
});

describe('rebuild-check: ledger accept and run', () => {
  let testDir;
  let projectsDir;
  let ledgerFile;

  beforeEach(async () => {
    testDir = await mkdir(join(tmpdir(), 'frl-rebuild-ledger-' + Date.now()), { recursive: true });
    projectsDir = join(testDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    ledgerFile = join(testDir, 'ledger.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeProject(id, project) {
    await writeFile(join(projectsDir, `${id}.json`), JSON.stringify(project, null, 2));
  }

  function runAccept(only = '') {
    const args = ['scripts/rebuild-check.mjs', 'accept', testDir, '--ledger', ledgerFile, '--reason', 'test reason'];
    if (only) args.push('--only', only);
    return spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  }

  function runRebuildCheckWithLedger(only = '') {
    const args = ['scripts/rebuild-check.mjs', 'run', testDir, '--ledger', ledgerFile];
    if (only) args.push('--only', only);
    return spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  }

  function runRebuildCheckNoLedger(only = '') {
    const args = ['scripts/rebuild-check.mjs', 'run', testDir];
    if (only) args.push('--only', only);
    return spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  }

  const baseItem = (url, answer, tier) => ({
    url,
    checks: [{ id: 'quality|Good?', answer, hard: true, clause: 'quality' }],
    tier,
    live: true,
    listing: true,
    inRange: answer === 'yes',
    purpose: []
  });

  const baseProject = {
    question: 'Test project',
    phase: 'done',
    acceptance: { itemCount: 2 },
    checklist: [{ clause: 'quality', items: [{ question: 'Good?', hard: true }] }],
    decisionModel: { kind: { label: 'item', terms: ['item'], members: [] } },
    acceptanceResult: {
      items: [
        baseItem('https://a.example.org/1', 'yes', 'confirmed'),
        baseItem('https://a.example.org/2', 'no', 'rejected')
      ],
      validCount: 1,
      totalAsked: 2,
      verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
      checks: [
        { id: 'count', value: 0.5, passed: false },
        { id: 'checklist-quality|Good?', value: 0.5, passed: false }
      ],
      score: 0.5
    },
    report: {
      verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)',
      options: [{ id: 'O1', option: 'Buy it' }],
      chosenOption: 'O1',
      chosenOptionNote: null
    },
    runOutcome: { state: 'short', confirmed: 1, asked: 2 }
  };

  it('accept command writes drifts to ledger', async () => {
    const project = {
      ...baseProject,
      id: 'accept-drift',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('accept-drift', project);

    const result = runAccept();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Accepted');
    expect(result.stdout).toContain('drift(s) into ledger');
  });

  it('run with ledger turns matching drift into ACCEPTED and exits 0', async () => {
    const project = {
      ...baseProject,
      id: 'ledger-match',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('ledger-match', project);

    const acceptResult = runAccept();
    expect(acceptResult.status).toBe(0);

    const runResult = runRebuildCheckWithLedger();
    expect(runResult.status).toBe(0);
    expect(runResult.stdout).toContain('ACCEPTED acceptance.confirmed: stored 1 rebuilt 2');
    expect(runResult.stdout).toContain('ACCEPTED acceptance.rejected: stored 1 rebuilt 0');
    expect(runResult.stdout).toContain('ACCEPTED verdict.confirmed: stored 1 rebuilt 2');
    expect(runResult.stdout).toContain('ACCEPTED verdict.rejected: stored 1 rebuilt 0');
    expect(runResult.stdout).toContain('rebuild-check: PASS');
  });

  it('run with ledger still FAILs when rebuilt value changed since acceptance', async () => {
    const project = {
      ...baseProject,
      id: 'ledger-changed',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('ledger-changed', project);

    const acceptResult = runAccept();
    expect(acceptResult.status).toBe(0);

    const projectChanged = {
      ...project,
      acceptanceResult: {
        ...project.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed'),
          baseItem('https://a.example.org/3', 'yes', 'confirmed')
        ],
        validCount: 3,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      }
    };
    await writeProject('ledger-changed', projectChanged);

    const runResult = runRebuildCheckWithLedger();
    expect(runResult.status).toBe(1);
    expect(runResult.stdout).toContain('DRIFT acceptance.confirmed');
    expect(runResult.stdout).toContain('rebuild-check: FAIL');
  });

  it('run with ledger reports stale entries', async () => {
    const project1 = {
      ...baseProject,
      id: 'stale-project-1',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    const project2 = {
      ...baseProject,
      id: 'stale-project-2',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/3', 'yes', 'confirmed'),
          baseItem('https://a.example.org/4', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('stale-project-1', project1);
    await writeProject('stale-project-2', project2);

    const acceptResult = runAccept();
    expect(acceptResult.status).toBe(0);

    await rm(join(projectsDir, 'stale-project-2.json'), { force: true });

    const runResult = runRebuildCheckWithLedger();
    expect(runResult.status).toBe(0);
    expect(runResult.stdout).toContain('stale ledger entries: 5');
  });

  it('no --ledger flag = unchanged behaviour (still FAILs on drift)', async () => {
    const project = {
      ...baseProject,
      id: 'no-ledger-drift',
      acceptanceResult: {
        ...baseProject.acceptanceResult,
        items: [
          baseItem('https://a.example.org/1', 'yes', 'confirmed'),
          baseItem('https://a.example.org/2', 'yes', 'confirmed')
        ],
        validCount: 2,
        verdict: { tiers: { confirmed: 1, toConfirm: 0, rejected: 1, notJudged: 0 } },
        checks: [
          { id: 'count', value: 0.5, passed: false },
          { id: 'checklist-quality|Good?', value: 0.5, passed: false }
        ],
        score: 0.5
      },
      report: {
        ...baseProject.report,
        verdict: 'VERDICT: PROVISIONAL (acceptance: 1 of 2 confirmed · 0 to confirm · 1 rejected · 0 not read)'
      },
      runOutcome: { state: 'short', confirmed: 1, asked: 2 }
    };
    await writeProject('no-ledger-drift', project);

    const runResult = runRebuildCheckNoLedger();
    expect(runResult.status).toBe(1);
    expect(runResult.stdout).toContain('DRIFT acceptance.confirmed: stored 1 rebuilt 2');
    expect(runResult.stdout).not.toContain('ACCEPTED');
    expect(runResult.stdout).toContain('rebuild-check: FAIL');
  });
});