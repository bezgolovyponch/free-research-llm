import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const VERIFIED_TIERS = ['fits', 'trade-off', 'unverified'];

const verifiable = (row) => VERIFIED_TIERS.includes(row.plan?.tier);

export function verifiableOf(candidates) {
  return (candidates?.kept ?? []).filter(verifiable).map((r) => r.url).sort();
}

export function verifiableSignature(candidates) {
  return crypto.createHash('sha256').update(JSON.stringify(verifiableOf(candidates))).digest('hex');
}

export async function readVerification(dir, id) {
  try {
    const record = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
    return record && Array.isArray(record.results) ? record : null;
  } catch {
    return null;
  }
}

export function applyVerification(candidates, record) {
  if (!candidates?.tiers) return candidates;
  const byUrl = new Map((record?.results ?? []).map((r) => [r.url, r]));
  const kept = candidates.kept.map((row) => {
    const result = byUrl.get(row.url);
    if (!verifiable(row)) return row;
    const failed = (result?.checks ?? []).filter((c) => c.status !== 'confirmed' && c.check !== 'location source').map((c) => `${c.check}: ${c.status} (${c.detail})`);
    return { ...row, verified: result ? { verdict: result.verdict, failed, at: record.at } : { verdict: 'pending', failed: [], at: null } };
  });
  const verdicts = (verdict) => kept.filter((r) => r.verified?.verdict === verdict).length;
  const confirmed = verdicts('confirmed');
  const fits = kept.filter((r) => r.plan?.tier === 'fits');
  const fitsWith = (verdict) => fits.filter((r) => r.verified?.verdict === verdict).length;
  return { ...candidates, kept, keptCount: fitsWith('confirmed'), verification: { at: record?.at ?? null, fits: fits.length, checked: kept.filter(verifiable).length, confirmed, refuted: verdicts('refuted'), unconfirmed: verdicts('unconfirmed'), pending: verdicts('pending'), fitsConfirmed: fitsWith('confirmed'), fitsRefuted: fitsWith('refuted'), fitsOpen: fitsWith('unconfirmed') + fitsWith('pending') } };
}
