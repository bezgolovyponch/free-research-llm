import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandoffWriter, handoffMarkdown, handoffRecord } from '../../src/research/handoff.mjs';

const project = {
  id: 'cars-abc123',
  question: 'Which cars resell from DE to CZ?',
  acceptance: { expected: '5 links' },
  phase: 'done',
  report: { verdict: 'GO-IF Focus gap holds', openQuestions: ['transport cost?'] },
  acceptanceResult: { score: 0.6, checks: [{ label: 'At least 5 items', value: 0.6 }], items: [{ title: 'Focus', url: 'https://k.example/1', live: true, inRange: true }, { url: 'https://k.example/2', live: false }] },
  improve: { baseline: 0.2, best: 0.35, trials: [{ nodeId: 'D1.1', outcome: 'kept', change: 'scan more models', before: 0.2, score: 0.35 }, { nodeId: 'D2.1', outcome: 'reverted-whole', change: 'new query', before: 0.35, score: 0.3 }] },
  nodes: [
    { id: 'D1.1', title: 'Gap scan', status: 'verified', finding: { answer: 'Ford Focus +9.9%', gaps: [] } },
    { id: 'D2.1', title: 'Transport', status: 'weak', finding: { answer: 'unknown', gaps: ['quote from a carrier'] }, verification: { failures: ['answer says the evidence cannot settle it'] } },
    { id: 'D3', title: 'Taxes', status: 'pending' },
  ],
};

describe('handoff', () => {
  it('captures status, insights, fixes kept and tried, weak pieces with reasons, deliverables and next steps', () => {
    const r = handoffRecord(project, { reason: 'loop ended', resume: { loopHoursLeft: 2.5 } });
    expect(r.progress).toEqual({ total: 3, passing: 1, pending: 1 });
    expect(r.insights).toEqual(['D1.1 [verified] Ford Focus +9.9%']);
    expect(r.fixesKept).toEqual(['D1.1: scan more models (0.2 → 0.35)']);
    expect(r.fixesTried).toEqual([{ nodeId: 'D1.1', attempts: 1, last: ['kept: scan more models'] }, { nodeId: 'D2.1', attempts: 1, last: ['reverted-whole: new query'] }]);
    expect(r.deliverables).toEqual([{ title: 'Focus', url: 'https://k.example/1', inRange: true }]);
    expect(r.nextSteps).toEqual(['Fix D2.1 (weak): answer says the evidence cannot settle it', 'transport cost?', 'Press Run (or start the loop): some pieces are not researched yet']);
    const md = handoffMarkdown(r);
    expect(md).toContain('reason: **loop ended**');
    expect(md).toContain('- D2.1 [weak] Transport: answer says the evidence cannot settle it; quote from a carrier');
    expect(md).toContain('had 2.5 h left; the app restarts it automatically');
  });

  it('writes JSON and Markdown, lists only interrupted work as resumable, and clears it once resumed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-handoff-'));
    const writer = new HandoffWriter({ dir });
    await writer.write(project, { reason: 'app stopped', resume: { loopHoursLeft: 3 } });
    await writer.write({ ...project, id: 'done-xyz123' }, { reason: 'research finished' });
    expect((await writer.resumable()).map((r: { projectId: string }) => r.projectId)).toEqual(['cars-abc123']);
    expect(await writer.markdown('cars-abc123')).toMatch(/^# Handoff: Which cars resell/);
    await writer.clearResume('cars-abc123');
    expect(await writer.resumable()).toEqual([]);
    expect(await writer.read('missing')).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
