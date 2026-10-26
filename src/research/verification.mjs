import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function fitsOf(candidates) {
  return (candidates?.kept ?? []).filter((r) => r.plan?.tier === 'fits').map((r) => r.url).sort();
}

export function fitsSignature(candidates) {
  return crypto.createHash('sha256').update(JSON.stringify(fitsOf(candidates))).digest('hex');
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
    if (row.plan?.tier !== 'fits') return row;
    const result = byUrl.get(row.url);
    const failed = (result?.checks ?? []).filter((c) => c.status !== 'confirmed' && c.check !== 'location source').map((c) => `${c.check}: ${c.status} (${c.detail})`);
    return { ...row, verified: result ? { verdict: result.verdict, failed, at: record.at } : { verdict: 'pending', failed: [], at: null } };
  });
  const fits = kept.filter((r) => r.plan?.tier === 'fits');
  const confirmed = fits.filter((r) => r.verified?.verdict === 'confirmed').length;
  return { ...candidates, kept, keptCount: confirmed, verification: { at: record?.at ?? null, fits: fits.length, confirmed, refuted: fits.filter((r) => r.verified?.verdict === 'refuted').length, unconfirmed: fits.filter((r) => r.verified?.verdict === 'unconfirmed').length, pending: fits.filter((r) => r.verified?.verdict === 'pending').length } };
}
