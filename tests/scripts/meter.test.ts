import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { meterProject, bandOf, findPageText, loadProjects, readCalls, parseArgs, ROOT, DATA_DIR } from '../../scripts/meter.mjs';
import { contractClass } from '../../src/research/deliverable.mjs';
import { wilson } from '../../src/research/agreement.mjs';

const makeProject = (overrides = {}) => ({
  id: 'test-project',
  question: 'Test question',
  phase: 'done',
  acceptance: { expected: '10 items' },
  acceptanceResult: {
    items: [
      { tier: 'confirmed', url: 'https://a.example.org/1', checks: [], evidence: 'https://a.example.org/1' },
      { tier: 'confirmed', url: 'https://a.example.org/2', checks: [], evidence: 'https://a.example.org/2' },
      { tier: 'to-confirm', url: 'https://a.example.org/3', checks: [], evidence: 'https://a.example.org/3' },
      { tier: 'rejected', url: 'https://a.example.org/4', checks: [], evidence: 'https://a.example.org/4' },
    ],
  },
  nodes: [
    {
      id: 'n1',
      status: 'verified',
      finding: {
        claims: [
          { answer: 'yes', quote: 'found text in page', evidence: 'https://a.example.org/1', support: { verdict: 'supported' } },
          { answer: 'yes', quote: 'some other text', evidence: 'https://a.example.org/2', support: { verdict: 'supported' } },
          { answer: 'no', quote: 'disagree', evidence: 'https://a.example.org/3', support: { verdict: 'disagree' } },
        ],
        calculation: { recomputed: 12.5 },
      },
    },
    {
      id: 'n2',
      status: 'supported',
      finding: {
        claims: [
          { answer: 'yes', quote: 'different content', evidence: 'https://a.example.org/3', support: { verdict: 'supported' } },
        ],
      },
    },
    {
      id: 'n3',
      status: 'weak',
      finding: {
        claims: [
          { answer: 'yes', quote: 'another quote', evidence: 'https://a.example.org/2', support: { verdict: 'supported' } },
        ],
      },
    },
    {
      id: 'n4',
      status: 'failed',
      finding: {
        claims: [],
      },
    },
  ],
  sources: [
    { url: 'https://a.example.org/1', text: 'found text in page' },
    { url: 'https://a.example.org/2', text: 'some other text and another quote' },
    { url: 'https://a.example.org/3', text: 'different content' },
  ],
  report: { chosenOption: 'O1' },
  ...overrides,
});

const makeCallRow = (overrides = {}) => ({
  ts: new Date().toISOString(),
  purpose: 'research',
  tier: 'fast',
  provider: 'provider1',
  model: 'model1',
  ok: true,
  ms: 100,
  tokens: 50,
  project: 'test-project',
  ...overrides,
});

describe('meter: parseArgs', () => {
  it('requires dataDir', () => {
    const result = parseArgs([]);
    expect(result.error).toContain('usage');
  });

  it('parses dataDir and out', () => {
    const result = parseArgs(['/data', '--out', '/data/out.json']);
    expect(result.dataDir).toBe(resolve('/data'));
    expect(result.out).toBe(resolve('/data/out.json'));
  });

  it('parses dataDir and out with relative paths', () => {
    const result = parseArgs(['./data', '--out', './data/out.json']);
    expect(result.dataDir).toBe(resolve('./data'));
    expect(result.out).toBe(resolve('./data/out.json'));
  });

  it('rejects --out outside data/ inside repo', () => {
    const result = parseArgs([DATA_DIR, '--out', join(ROOT, 'docs', 'out.json')]);
    expect(result.error).toContain('must be under data/');
  });

  it('parses void-providers', () => {
    const result = parseArgs(['/data', '--void-providers', 'p1,p2']);
    expect(result.voidProviders).toEqual(new Set(['p1', 'p2']));
  });
});

describe('meter: calls', () => {
  it('counts ok, failed, total, failedShare, tokens, providers, singleProvider', () => {
    const project = makeProject();
    const rows = [
      makeCallRow({ ok: true, provider: 'p1', tokens: 10 }),
      makeCallRow({ ok: true, provider: 'p1', tokens: 20 }),
      makeCallRow({ ok: true, provider: 'p2', tokens: 30 }),
      makeCallRow({ ok: true, provider: 'p2', tokens: 40 }),
      makeCallRow({ ok: true, provider: 'p3', tokens: 50 }),
      makeCallRow({ ok: false, provider: 'p1' }),
      makeCallRow({ ok: false, provider: 'p2' }),
      makeCallRow({ purpose: 'router', provider: 'router', ok: true, tokens: 5 }),
      makeCallRow({ project: 'other-project', ok: true, tokens: 100 }),
    ];
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.calls.ok).toBe(5);
    expect(result.calls.failed).toBe(2);
    expect(result.calls.total).toBe(7);
    expect(result.calls.failedShare).toBeCloseTo(2 / 7);
    expect(result.calls.tokens).toBe(150);
    expect(result.calls.providers).toEqual({ p1: 2, p2: 2, p3: 1 });
    expect(result.calls.singleProvider).toBe(false);
  });

  it('research with no rows gives total 0, failedShare null, settledPerCall null and label no calls', () => {
    const project = makeProject();
    const rows = [];
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.calls.total).toBe(0);
    expect(result.calls.failedShare).toBeNull();
    expect(result.settledPerCall).toBeNull();
    expect(result.settledPerCallLabel).toBe('no calls');
  });
});

describe('meter: void', () => {
  it('void true when provider in voidProviders', () => {
    const project = makeProject();
    const rows = [makeCallRow({ ok: true, provider: 'void-provider' })];
    const result = meterProject(project, rows, { voidProviders: new Set(['void-provider']) });
    expect(result.calls.void).toBe(true);
  });

  it('void false when no voidProviders list', () => {
    const project = makeProject();
    const rows = [makeCallRow({ ok: true, provider: 'p1' })];
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.calls.void).toBe(false);
  });
});

describe('meter: settled', () => {
  it('counts confirmed, toConfirm, rejected, notJudged from stored tiers', () => {
    const project = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.settled.items.confirmed).toBe(2);
    expect(result.settled.items.toConfirm).toBe(1);
    expect(result.settled.items.rejected).toBe(1);
    expect(result.settled.items.notJudged).toBe(0);
    expect(result.settled.pieces.settled).toBe(2);
    expect(result.settled.pieces.total).toBe(4);
    expect(result.settled.units).toBe(4);
  });

  it('settledPerCall = units / total calls', () => {
    const project = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.settledPerCall).toBeCloseTo(4 / 8);
  });
});

describe('meter: claims', () => {
  it('computes supported, notSupported, share and Wilson interval from supportAudit', () => {
    const project = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.claims.supported).toBe(4);
    expect(result.claims.notSupported).toBe(1);
    expect(result.claims.unchecked).toBe(0);
    expect(result.claims.share).toBeCloseTo(4 / 5);
    const interval = wilson(4, 5);
    expect(result.claims.interval.low).toBeCloseTo(interval.low);
    expect(result.claims.interval.high).toBeCloseTo(interval.high);
  });
});

describe('meter: evidence tiers', () => {
  it('counts quoteFound, quoteNotFound, noQuote, noPageText, verifiedShare, recomputed', () => {
    const project = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const result = meterProject(project, rows, { voidProviders: new Set() });
    expect(result.evidence.quoteFound).toBe(4);
    expect(result.evidence.quoteNotFound).toBe(0);
    expect(result.evidence.noQuote).toBe(0);
    expect(result.evidence.noPageText).toBe(0);
    expect(result.evidence.verifiedShare).toBe(1);
    expect(result.evidence.recomputed).toBe(1);
  });
});

describe('meter: bandOf', () => {
  it('groups by question and expected, computes min/max for measures, chosenOption agreement', () => {
    const baseProject = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const m1 = meterProject({ ...baseProject, id: 'p1' }, rows, { voidProviders: new Set() });
    const m2 = meterProject({ ...baseProject, id: 'p2' }, rows, { voidProviders: new Set() });
    const m3 = meterProject({ ...baseProject, id: 'p3' }, rows, { voidProviders: new Set() });
    m1.settledPerCall = 0.5;
    m1.calls.failedShare = 0;
    m1.claims.share = 0.6;
    m1.evidence.verifiedShare = 0.5;
    m1.chosenOption = 'O1';
    m2.settledPerCall = 0.25;
    m2.calls.failedShare = 0.25;
    m2.claims.share = 0.5;
    m2.evidence.verifiedShare = 0.4;
    m2.chosenOption = 'O1';
    m3.settledPerCall = 0.75;
    m3.calls.failedShare = 0;
    m3.claims.share = 0.75;
    m3.evidence.verifiedShare = 0.6;
    m3.chosenOption = 'O2';
    const bands = bandOf([m1, m2, m3]);
    expect(bands.bands).toHaveLength(1);
    const band = bands.bands[0];
    expect(band.n).toBe(3);
    expect(band.calls_failedShare.min).toBe(0);
    expect(band.calls_failedShare.max).toBe(0.25);
    expect(band.settledPerCall.min).toBe(0.25);
    expect(band.settledPerCall.max).toBe(0.75);
    expect(band.claims_share.min).toBe(0.5);
    expect(band.claims_share.max).toBe(0.75);
    expect(band.evidence_verifiedShare.min).toBe(0.4);
    expect(band.evidence_verifiedShare.max).toBe(0.6);
    expect(band.chosenOptionAgreement).toBeCloseTo(2 / 3);
  });

  it('chosenOption not measurable when any run has absent', () => {
    const baseProject = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const m1 = meterProject({ ...baseProject, id: 'p1' }, rows, { voidProviders: new Set() });
    const m2 = meterProject({ ...baseProject, id: 'p2' }, rows, { voidProviders: new Set() });
    m1.settledPerCall = 0.5;
    m1.calls.failedShare = 0;
    m1.claims.share = 0.6;
    m1.evidence.verifiedShare = 0.5;
    m1.chosenOption = 'O1';
    m2.settledPerCall = 0.25;
    m2.calls.failedShare = 0;
    m2.claims.share = 0.5;
    m2.evidence.verifiedShare = 0.4;
    m2.chosenOption = 'absent';
    const bands = bandOf([m1, m2]);
    expect(bands.bands[0].chosenOptionAgreement).toBe('not measurable');
  });

  it('single research forms no band', () => {
    const baseProject = makeProject();
    const rows = Array(8).fill(null).map(() => makeCallRow());
    const m1 = meterProject({ ...baseProject, id: 'p1' }, rows, { voidProviders: new Set() });
    m1.settledPerCall = 0.5;
    const bands = bandOf([m1]);
    expect(bands.bands).toHaveLength(0);
  });
});

describe('meter: byKind', () => {
  it('one entry per kind with sums and recomputed ratios', () => {
    const listProject = makeProject({ id: 'list1' });
    const analysisProject = makeProject({
      id: 'analysis1',
      acceptance: { expected: '' },
      acceptanceResult: { items: [] },
      nodes: [{ id: 'n1', status: 'verified', finding: { claims: [], calculation: {} } }],
    });
    const memoProject = makeProject({
      id: 'memo1',
      acceptance: { expected: '' },
      acceptanceResult: { items: [] },
      nodes: [{ id: 'n1', status: 'covered', finding: { claims: [], calculation: {} } }],
    });
    const meters = [listProject, analysisProject, memoProject].map((p) => meterProject(p, [], { voidProviders: new Set() }));
    const { byKind } = bandOf(meters);
    expect(Object.keys(byKind)).toHaveLength(2);
    expect(byKind.list).toBeDefined();
    expect(byKind.analysis).toBeDefined();
    expect(byKind.list.projects).toBe(1);
    expect(byKind.analysis.projects).toBe(2);
    for (const kind of Object.keys(byKind)) {
      const failedShare = byKind[kind].calls.failedShare;
      expect(failedShare === null || typeof failedShare === 'number').toBe(true);
      const settledPerCall = byKind[kind].settledPerCall;
      expect(settledPerCall === null || typeof settledPerCall === 'number').toBe(true);
      const claimsShare = byKind[kind].claims.share;
      expect(claimsShare === null || typeof claimsShare === 'number').toBe(true);
      const verifiedShare = byKind[kind].evidence.verifiedShare;
      expect(verifiedShare === null || typeof verifiedShare === 'number').toBe(true);
    }
  });
});

describe('meter: findPageText', () => {
  it('finds page text from node sources', () => {
    const project = makeProject();
    const text = findPageText(project, 'https://a.example.org/1');
    expect(text).toBe('found text in page');
  });

  it('finds page text from project sources', () => {
    const project = makeProject();
    const text = findPageText(project, 'https://a.example.org/2');
    expect(text).toBe('some other text and another quote');
  });

  it('returns null for unknown url', () => {
    const project = makeProject();
    const text = findPageText(project, 'https://unknown.example.org/1');
    expect(text).toBeNull();
  });
});

describe('meter: contractClass', () => {
  it('returns list for project with item count', () => {
    const project = makeProject({ acceptance: { expected: '10 items' } });
    expect(contractClass(project)).toBe('list');
  });

  it('returns analysis for project without item count', () => {
    const project = makeProject({ acceptance: { expected: '' }, decisionModel: { criteria: [] } });
    expect(contractClass(project)).toBe('analysis');
  });
});

describe('meter: real path with ModelRouter', () => {
  it('writes call rows with real router and runs meter as child process', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-meter-test-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const logsDir = join(dir, 'logs');
    await mkdir(logsDir, { recursive: true });

    const project = makeProject({ id: 'real-test' });
    await writeFile(join(projectsDir, 'real-test.json'), JSON.stringify(project));

    const callsPath = join(logsDir, 'model-calls.jsonl');
    const rows = [
      { ts: new Date().toISOString(), purpose: 'research', tier: 'fast', provider: 'p1', model: 'm1', ok: true, ms: 100, tokens: 10, project: 'real-test' },
      { ts: new Date().toISOString(), purpose: 'research', tier: 'fast', provider: 'p1', model: 'm1', ok: true, ms: 100, tokens: 20, project: 'real-test' },
      { ts: new Date().toISOString(), purpose: 'research', tier: 'fast', provider: 'p2', model: 'm2', ok: true, ms: 100, tokens: 30, project: 'real-test' },
      { ts: new Date().toISOString(), purpose: 'router', tier: 'fast', provider: 'router', model: 'm1', ok: true, ms: 10, tokens: 0, project: 'real-test' },
    ];
    await writeFile(callsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const outFile = join(tmpdir(), 'meter-out-' + Date.now() + '.json');
    const { execSync } = await import('node:child_process');
    const scriptPath = join(process.cwd(), 'scripts/meter.mjs');
    const result = execSync(`"${process.execPath}" "${scriptPath}" "${dir}" --out "${outFile}"`, { encoding: 'utf8', timeout: 30000, windowsHide: true });
    expect(result).toContain('Written to');

    const output = JSON.parse(await readFile(outFile, 'utf8'));
    expect(output.projects).toHaveLength(1);
    expect(output.projects[0].calls.ok).toBe(3);
    expect(output.projects[0].calls.failed).toBe(0);
    expect(output.projects[0].calls.total).toBe(3);
    expect(output.projects[0].calls.providers).toEqual({ p1: 2, p2: 1 });

    await rm(dir, { recursive: true, force: true });
    await rm(outFile, { force: true });
  });
});