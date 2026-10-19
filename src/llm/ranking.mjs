export const STRATEGIES = {
  balanced: { label: 'Balanced', what: 'Reliable and capable first, speed breaks ties. Deep work weighs capability, fast work weighs speed.' },
  fastest: { label: 'Fastest', what: 'Lowest median reply time first, among providers that answer at least half of their calls.' },
  smartest: { label: 'Smartest', what: 'Most capable model first, then the most reliable.' },
  custom: { label: 'Custom', what: 'Your own order, the same for both roles. Move providers with the arrows.' },
};

export const CAPABILITY = {
  gemini: [5, 'Gemini Flash, the strongest free model'],
  mistral: [4, 'Mistral Large'],
  cerebras: [4, 'gpt-oss-120b'],
  groq: [4, 'gpt-oss-120b'],
  nvidia: [4, 'gpt-oss-120b, DeepSeek, Llama 3.3 70B'],
  sambanova: [4, 'DeepSeek-V3.2'],
  puter: [4, 'GPT, Claude, Gemini through one account'],
  openrouter: [3, 'whichever :free model is up'],
  cohere: [3, 'Command A'],
  custom: [3, 'depends on your endpoint'],
  cloudflare: [2, 'Llama 3.3 70B fp8, small daily pool'],
  pollinations: [2, 'small keyless model, 1 reply per 30 s'],
  ollama: [1, 'a 7–8B model on this computer'],
};

const WEIGHTS = {
  deep: { capability: 0.45, reliability: 0.35, speed: 0.2 },
  fast: { capability: 0.25, reliability: 0.4, speed: 0.35 },
};
const WINDOW_MS = 24 * 3600 * 1000;
const MIN_RELIABILITY = 0.5;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function providerStats(ledger, { now = Date.now(), windowMs = WINDOW_MS } = {}) {
  const stats = {};
  for (const row of ledger) {
    if (!row?.provider || row.provider === 'router') continue;
    if (row.ts && now - Date.parse(row.ts) > windowMs) continue;
    const s = (stats[row.provider] ??= { calls: 0, ok: 0, failed: 0, rateLimited: 0, ms: { fast: [], deep: [], all: [] } });
    s.calls++;
    if (row.ok) {
      s.ok++;
      if (Number(row.ms) > 0) {
        s.ms.all.push(Number(row.ms));
        if (s.ms[row.tier]) s.ms[row.tier].push(Number(row.ms));
      }
    } else {
      s.failed++;
      if (/429|413|quota|rate|limit/i.test(String(row.error ?? ''))) s.rateLimited++;
    }
  }
  return Object.fromEntries(Object.entries(stats).map(([id, s]) => [id, { calls: s.calls, ok: s.ok, failed: s.failed, rateLimited: s.rateLimited, reliability: (s.ok + 1) / (s.calls + 2), medianMs: { fast: median(s.ms.fast) ?? median(s.ms.all), deep: median(s.ms.deep) ?? median(s.ms.all) } }]));
}

function reasonFor(row, role, strategy, rank) {
  if (!row.ready) return row.notReady;
  const parts = [];
  if (row.cooling) parts.push(`cooling ${row.cooling} s, skipped until then`);
  if (strategy === 'custom') parts.push(`your position ${rank + 1}`);
  else if (strategy === 'fastest') parts.push(row.medianMs ? `median ${(row.medianMs / 1000).toFixed(1)} s` : 'no timing yet, placed after measured ones');
  else if (strategy === 'smartest') parts.push(`capability ${row.capability}/5`);
  else parts.push(`score ${row.score.toFixed(2)}: capability ${row.capability}/5, reliability ${Math.round(row.reliability * 100)}%, ${row.medianMs ? `${(row.medianMs / 1000).toFixed(1)} s` : 'no timing yet'}`);
  if (row.reliability < MIN_RELIABILITY && row.calls >= 4) parts.push(`moved down: only ${Math.round(row.reliability * 100)}% of calls worked`);
  return parts.join(' · ');
}

export function rankRole({ role, strategy, providers, stats, customOrder = [], now = Date.now() }) {
  const rows = providers.map((p) => {
    const s = stats[p.id] ?? { calls: 0, ok: 0, failed: 0, rateLimited: 0, reliability: 0.5, medianMs: {} };
    const [capability, capabilityBasis] = CAPABILITY[p.id] ?? [3, 'unrated'];
    return { id: p.id, label: p.label, model: p[role] ?? null, ready: p.state === 'ready', notReady: p.state === 'ready' ? '' : p.detail || 'not connected', cooling: p.coolingDownMs > 0 ? Math.ceil(p.coolingDownMs / 1000) : 0, capability, capabilityBasis, reliability: s.reliability, calls: s.calls, ok: s.ok, failed: s.failed, rateLimited: s.rateLimited, medianMs: s.medianMs[role] ?? null };
  });
  const timed = rows.filter((r) => r.medianMs).map((r) => r.medianMs);
  const fastest = timed.length ? Math.min(...timed) : null;
  const w = WEIGHTS[role];
  for (const r of rows) {
    const speed = r.medianMs && fastest ? fastest / r.medianMs : 0.5;
    r.score = w.capability * (r.capability / 5) + w.reliability * r.reliability + w.speed * speed;
  }
  const weak = (r) => (r.reliability < MIN_RELIABILITY && r.calls >= 4 ? 1 : 0);
  const custom = (r) => {
    const i = customOrder.indexOf(r.id);
    return i < 0 ? customOrder.length : i;
  };
  const compare = {
    custom: (a, b) => custom(a) - custom(b),
    fastest: (a, b) => weak(a) - weak(b) || (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity) || b.score - a.score,
    smartest: (a, b) => b.capability - a.capability || b.reliability - a.reliability,
    balanced: (a, b) => weak(a) - weak(b) || b.score - a.score,
  }[strategy] ?? ((a, b) => b.score - a.score);
  const ordered = [...rows].sort((a, b) => Number(b.ready) - Number(a.ready) || compare(a, b) || a.id.localeCompare(b.id));
  return ordered.map((r, rank) => ({ ...r, rank: r.ready ? rank + 1 : null, why: reasonFor(r, role, strategy, rank), score: Math.round(r.score * 100) / 100, reliability: Math.round(r.reliability * 100) / 100 }));
}

export function routeFor({ strategy, providers, ledger, enabled, customOrder, now = Date.now() }) {
  const used = providers.filter((p) => enabled.includes(p.id));
  const stats = providerStats(ledger, { now });
  const deep = rankRole({ role: 'deep', strategy, providers: used, stats, customOrder, now });
  const fast = rankRole({ role: 'fast', strategy, providers: used, stats, customOrder, now });
  return { deep, fast, order: { deep: deep.map((r) => r.id), fast: fast.map((r) => r.id) }, stats };
}
