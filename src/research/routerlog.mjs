export const WAIT_LINE_MS = 60000;

function seconds(ms) {
  return Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
}

export function routerLine(event) {
  if (event?.kind === 'waiting') {
    const rests = (event.resting ?? []).map((rest) => `${rest.provider} rests ${seconds(rest.ms)}s (${rest.reason})`);
    return `waiting for model quota: ${rests.length ? rests.join(', ') : `${seconds(event.ms)}s`}`;
  }
  if (event?.kind === 'gave-up') return `no model answered ${event.purpose}: ${(event.reasons ?? []).join('; ')}`;
  if (event?.kind === 'excluded') return `${event.provider} needs payment: excluded from the free route`;
  return '';
}

export function failureKind(error) {
  const text = String(error ?? '');
  const status = /HTTP (\d{3})/.exec(text)?.[1];
  const window = /quota window: (per [a-z]+)/.exec(text)?.[1];
  if (status) return window ? `${status} ${window}` : status;
  if (/timed out/i.test(text)) return 'timed out';
  if (/unreachable|fetch failed/i.test(text)) return 'unreachable';
  return 'unusable reply';
}

export function callSummary(rows = []) {
  const calls = rows.filter((row) => row?.provider && row.provider !== 'router' && row.purpose !== 'router');
  const failed = calls.filter((row) => !row.ok);
  const counts = new Map();
  for (const row of failed) {
    const key = `${row.provider} ${failureKind(row.error)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  const ok = calls.length - failed.length;
  return { ok, failed: failed.length, line: calls.length ? `model calls this phase: ${ok} ok, ${failed.length} failed${top ? ` (top: ${top[0]} x${top[1]})` : ''}` : '' };
}
