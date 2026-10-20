export const STRATEGIES = {
  max: { label: 'Maximum capability', what: 'Each kind of call gets the strongest model that can take it: memo, tree and code go to the most capable; research to capable models with volume, escalating to the strongest when checks fail (FrugalGPT cascade); reviews and roll-ups to fast models of a different family than the one that wrote the answer. The strongest model\'s quota is kept for the important calls, spent keys wait for their daily reset, and prompts too big for a provider skip it.' },
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
  llamacpp: [2, 'depends on the model you run'],
};

export function localCapability(model) {
  const text = String(model ?? '');
  if (/\d+(?:\.\d+)?\s*m\b/i.test(text) && !/\d+(?:\.\d+)?\s*b\b/i.test(text)) return 1;
  const size = Number(text.match(/(\d+(?:\.\d+)?)\s*b\b/i)?.[1] ?? NaN);
  if (!Number.isFinite(size)) return null;
  return size >= 27 ? 4 : size >= 14 ? 3 : size >= 4 ? 2 : 1;
}

export function capabilityOf(p) {
  const local = p.local || p.id === 'llamacpp' || p.id === 'ollama';
  const measured = local ? localCapability(p.servedModel ?? p.deep) : null;
  if (measured) return [measured, `${p.servedModel ?? p.deep} on your own hardware`];
  return CAPABILITY[p.id] ?? [3, 'unrated'];
}

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
  if (row.cooling) parts.push(row.coolingReason ? `benched ${row.cooling > 3600 ? `${Math.round(row.cooling / 3600)} h` : `${row.cooling} s`}: ${row.coolingReason}` : `cooling ${row.cooling} s, skipped until then`);
  if (strategy === 'custom') parts.push(`your position ${rank + 1}`);
  else if (strategy === 'fastest') parts.push(row.medianMs ? `median ${(row.medianMs / 1000).toFixed(1)} s` : 'no timing yet, placed after measured ones');
  else if (strategy === 'smartest') parts.push(`capability ${row.capability}/5`);
  else parts.push(`score ${row.score.toFixed(2)}: capability ${row.capability}/5, reliability ${Math.round(row.reliability * 100)}%, ${row.medianMs ? `${(row.medianMs / 1000).toFixed(1)} s` : 'no timing yet'}`);
  if (row.reliability < MIN_RELIABILITY && row.calls >= 4) parts.push(`moved down: only ${Math.round(row.reliability * 100)}% of calls worked`);
  if (row.capability <= 1 && strategy !== 'custom' && strategy !== 'smartest') parts.push('kept last: too small for research');
  return parts.join(' · ');
}

export function rankRole({ role, strategy, providers, stats, customOrder = [], now = Date.now() }) {
  const rows = providers.map((p) => {
    const s = stats[p.id] ?? { calls: 0, ok: 0, failed: 0, rateLimited: 0, reliability: 0.5, medianMs: {} };
    const [capability, capabilityBasis] = capabilityOf(p);
    return { id: p.id, label: p.label, model: p[role] ?? null, ready: p.state === 'ready', notReady: p.state === 'ready' ? '' : p.detail || 'not connected', cooling: p.coolingDownMs > 0 ? Math.ceil(p.coolingDownMs / 1000) : 0, coolingReason: p.coolingReason ?? null, capability, capabilityBasis, reliability: s.reliability, calls: s.calls, ok: s.ok, failed: s.failed, rateLimited: s.rateLimited, medianMs: s.medianMs[role] ?? null };
  });
  const timed = rows.filter((r) => r.medianMs).map((r) => r.medianMs);
  const fastest = timed.length ? Math.min(...timed) : null;
  const w = WEIGHTS[role];
  for (const r of rows) {
    const speed = r.medianMs && fastest ? fastest / r.medianMs : 0.5;
    r.score = w.capability * (r.capability / 5) + w.reliability * r.reliability + w.speed * speed;
  }
  const weak = (r) => (r.capability <= 1 ? 2 : 0) + (r.reliability < MIN_RELIABILITY && r.calls >= 4 ? 1 : 0);
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

export const DAILY_LIMITS = {
  groq: { requests: 1000, note: '1,000 requests/day per model' },
  openrouter: { requests: 50, note: '50 requests/day on :free models' },
  sambanova: { requests: 20, note: '20 requests/day' },
  cerebras: { tokens: 1000000, note: '1M tokens/day' },
  cloudflare: { note: '10,000 neurons/day (not countable here)' },
  gemini: { note: 'per-model daily limit, shown in AI Studio' },
  mistral: { note: '1B tokens/month per model' },
  cohere: { note: '1,000 calls/month' },
  pollinations: { note: 'no daily cap; 1 reply per 30 s without a key' },
  llamacpp: { note: 'unlimited: your own GPU' },
};

function utcDay(ts) {
  return String(ts ?? '').slice(0, 10);
}

export function usageInfo(rows, { now = Date.now(), windowMs = WINDOW_MS } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const per = {};
  let total = 0;
  for (const row of rows) {
    if (!row?.provider || row.provider === 'router' || !row.ts) continue;
    const age = now - Date.parse(row.ts);
    const u = (per[row.provider] ??= { calls: 0, ok: 0, rateLimited: 0, errors: 0, tokens: 0, ms: [], hourly: Array(24).fill(0), models: {}, purposes: {}, today: { requests: 0, tokens: 0 } });
    if (utcDay(row.ts) === today) {
      u.today.requests++;
      u.today.tokens += Number(row.tokens) || 0;
    }
    if (age > windowMs || age < 0) continue;
    total++;
    u.calls++;
    u.hourly[23 - Math.min(23, Math.floor(age / 3600000))]++;
    if (row.ok) {
      u.ok++;
      u.tokens += Number(row.tokens) || 0;
      if (Number(row.ms) > 0) u.ms.push(Number(row.ms));
      if (row.model) u.models[row.model] = (u.models[row.model] ?? 0) + 1;
    } else if (/429|413|quota|rate|limit|402/i.test(String(row.error ?? ''))) u.rateLimited++;
    else u.errors++;
    if (row.purpose) u.purposes[row.purpose] = (u.purposes[row.purpose] ?? 0) + 1;
  }
  const providers = Object.fromEntries(Object.entries(per).map(([id, u]) => {
    const limit = DAILY_LIMITS[id] ?? {};
    const used = limit.requests ? u.today.requests / limit.requests : limit.tokens ? u.today.tokens / limit.tokens : null;
    return [id, {
      calls: u.calls,
      ok: u.ok,
      rateLimited: u.rateLimited,
      errors: u.errors,
      tokens: u.tokens,
      share: total ? Math.round((u.calls / total) * 1000) / 1000 : 0,
      medianMs: median(u.ms),
      hourly: u.hourly,
      models: Object.entries(u.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model, calls]) => ({ model, calls })),
      purposes: Object.entries(u.purposes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([purpose, calls]) => ({ purpose, calls })),
      today: { ...u.today, limit: limit.requests ?? limit.tokens ?? null, unit: limit.requests ? 'requests' : limit.tokens ? 'tokens' : null, used: used === null ? null : Math.round(used * 1000) / 1000, note: limit.note ?? '' },
    }];
  }));
  return { total, providers };
}

export const PURPOSE_CLASS = {
  synthesize: 'top', decompose: 'top', expand: 'top', code: 'top', 'code-plan': 'top', improve: 'top', suggest: 'top',
  research: 'research',
  critique: 'volume', rollup: 'volume', 'app-chat': 'volume', 'results-chat': 'volume', chat: 'volume', media: 'volume',
};
export const MAX_PROMPT_TOKENS = { groq: 7000 };
const RESERVE_UNTIL = 0.7;

export function familyOf(model, providerId = '') {
  const m = String(model ?? '').toLowerCase();
  for (const [family, re] of [['gpt-oss', /gpt-oss/], ['gemini', /gemini|gemma/], ['deepseek', /deepseek/], ['llama', /llama/], ['qwen', /qwen/], ['minimax', /minimax/], ['mistral', /mistral|magistral|codestral/], ['claude', /claude/], ['openai', /gpt-|openai/], ['command', /command/]]) if (re.test(m)) return family;
  return providerId || 'unknown';
}

function orderBy(rows, compare) {
  return [...rows].sort((a, b) => Number(b.ready) - Number(a.ready) || compare(a, b) || a.id.localeCompare(b.id)).map((r) => r.id);
}

export function purposePlan({ providers, stats, usage = {}, enabled }) {
  const used = providers.filter((p) => enabled.includes(p.id));
  const deep = rankRole({ role: 'deep', strategy: 'balanced', providers: used, stats });
  const fast = rankRole({ role: 'fast', strategy: 'balanced', providers: used, stats });
  const weak = (r) => (r.capability <= 1 ? 2 : 0) + (r.reliability < 0.5 && r.calls >= 4 ? 1 : 0);
  const spent = (r) => ((usage[r.id]?.today?.used ?? 0) >= 0.9 ? 1 : 0);
  const reserved = deep.filter((r) => r.ready).sort((a, b) => b.capability - a.capability || b.reliability - a.reliability)[0]?.id;
  const reservedTight = reserved && (usage[reserved]?.today?.used ?? 0) >= RESERVE_UNTIL;
  const top = orderBy(deep, (a, b) => weak(a) - weak(b) || spent(a) - spent(b) || b.capability - a.capability || b.reliability - a.reliability);
  const research = orderBy(deep, (a, b) => weak(a) - weak(b) || spent(a) - spent(b) || Number(a.id === reserved && reservedTight) - Number(b.id === reserved && reservedTight) || b.score - a.score);
  const volume = orderBy(fast, (a, b) => weak(a) - weak(b) || spent(a) - spent(b) || Number(a.id === reserved) - Number(b.id === reserved) || (b.capability >= 3) - (a.capability >= 3) || (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9));
  const orders = { top, research, volume };
  const byPurpose = Object.fromEntries(Object.entries(PURPOSE_CLASS).map(([purpose, cls]) => [purpose, orders[cls]]));
  byPurpose['research:deep'] = top;
  return { byPurpose, reserved: reserved ?? null, orders };
}
