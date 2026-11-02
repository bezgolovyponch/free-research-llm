import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyVerification, readVerification, verifiableOf, verifiableSignature } from '../../src/research/verification.mjs';
import { candidateDeliverables } from '../../src/research/candidates.mjs';

const row = (url: string, tier: string) => ({ url, title: url, price: 5000, currency: 'EUR', plan: { tier } });
const table = { tiers: { fits: 3 }, keptCount: 3, kept: [row('a', 'fits'), row('b', 'fits'), row('c', 'fits'), row('d', 'trade-off')] };
const record = { at: '2026-10-26T18:00:00Z', results: [
  { url: 'a', verdict: 'confirmed', checks: [{ check: 'price on the page', status: 'confirmed', detail: 'page 5000, app 5000' }] },
  { url: 'b', verdict: 'refuted', checks: [{ check: 'sea within 20 km', status: 'refuted', detail: 'no coastline within 25 km' }, { check: 'location source', status: 'unconfirmed', detail: 'the app\'s point was used' }] },
] };

describe('external verification on the app side', () => {
  it('counts only plots the external verifier confirmed; refuted and unchecked ones never count (fail-closed)', () => {
    const out = applyVerification(table, record);
    expect(out.keptCount).toBe(1);
    expect(out.verification).toEqual({ at: '2026-10-26T18:00:00Z', fits: 3, checked: 4, confirmed: 1, refuted: 1, unconfirmed: 0, pending: 2 });
    expect(out.kept.find((r: { url: string }) => r.url === 'b').verified).toEqual({ verdict: 'refuted', failed: ['sea within 20 km: refuted (no coastline within 25 km)'], at: '2026-10-26T18:00:00Z' });
    expect(out.kept.find((r: { url: string }) => r.url === 'c').verified.verdict).toBe('pending');
    expect(out.kept.find((r: { url: string }) => r.url === 'd').verified.verdict).toBe('pending');
    expect(candidateDeliverables(out).map((d: { url: string }) => d.url)).toEqual(['a']);
    expect(applyVerification(table, null).keptCount).toBe(0);
    expect(applyVerification({ kept: [] }, record)).toEqual({ kept: [] });
  });

  it('counts a verifier-confirmed row as a deliverable only while it still fits every check', () => {
    const out = applyVerification(table, record);
    const d = candidateDeliverables(out);
    expect(d.map((x) => x.url)).toEqual(['a']);
    const tradeOff = { ...table, kept: [row('x', 'trade-off'), row('y', 'weak')] };
    const rec2 = { at: record.at, results: [
      { url: 'x', verdict: 'confirmed', checks: [] },
      { url: 'y', verdict: 'confirmed', checks: [] },
    ] };
    const out2 = applyVerification(tradeOff, rec2);
    expect(candidateDeliverables(out2).map((x) => x.url)).toEqual([]);
    expect(out2.kept.find((r: { url: string }) => r.url === 'y').verified).toBeUndefined();
    const fits = { ...table, kept: [row('z', 'fits')] };
    const out3 = applyVerification(fits, { at: record.at, results: [{ url: 'z', verdict: 'confirmed', checks: [] }] });
    expect(candidateDeliverables(out3).map((x) => x.url)).toEqual(['z']);
  });

  it('knows when the set of rows to verify changed, so the verifier runs again only then', () => {
    expect(verifiableOf(table)).toEqual(['a', 'b', 'c', 'd']);
    expect(verifiableSignature(table)).toBe(verifiableSignature({ kept: [...table.kept].reverse() }));
    expect(verifiableSignature(table)).not.toBe(verifiableSignature({ kept: table.kept.slice(1) }));
  });

  it('asks for verification when no row fits but trade-offs and rows to confirm exist, so a table with 0 fits never stalls the loop', () => {
    const noFits = { tiers: { fits: 0 }, kept: [row('t', 'trade-off'), row('u', 'unverified'), row('w', 'weak'), row('z', 'blocked')] };
    const out = applyVerification(noFits, null);
    expect(out.verification).toMatchObject({ fits: 0, checked: 2, pending: 2 });
    expect(out.kept.filter((r: { verified?: unknown }) => r.verified).map((r: { url: string }) => r.url)).toEqual(['t', 'u']);
  });

  it('counts only confirmed fits as kept, while the verification summary still counts every confirmed tier', () => {
    const rows = [row('a', 'fits'), row('b', 'fits'), row('c', 'trade-off'), row('d', 'fits')];
    const rec = { at: '2026-11-01T00:00:00Z', results: [
      { url: 'a', verdict: 'confirmed', checks: [] },
      { url: 'b', verdict: 'confirmed', checks: [] },
      { url: 'c', verdict: 'confirmed', checks: [] },
      { url: 'd', verdict: 'refuted', checks: [] },
    ] };
    const out = applyVerification({ tiers: { fits: 3 }, kept: rows }, rec);
    expect(out.keptCount).toBe(2);
    expect(out.verification.confirmed).toBe(3);
  });

  it('reads the verifier\'s record read-only and treats a missing or broken file as no verification', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-verif-'));
    await fs.writeFile(path.join(dir, 'p1.json'), JSON.stringify(record));
    await fs.writeFile(path.join(dir, 'p2.json'), '{broken');
    expect((await readVerification(dir, 'p1'))?.results).toHaveLength(2);
    expect(await readVerification(dir, 'p2')).toBeNull();
    expect(await readVerification(dir, 'missing')).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
