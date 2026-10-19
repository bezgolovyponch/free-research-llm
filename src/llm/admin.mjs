import { PROVIDER_PRESETS, ROUTE_ORDER, SEARCH_KEYS } from './presets.mjs';
import { KeyChecker } from '../keycheck.mjs';

export const FREE_TIERS_CHECKED = '2026-10-18';
export const FREE_TIERS = {
  gemini: 'per-model requests per minute and per day, shown in your AI Studio dashboard · no card',
  groq: 'gpt-oss: 30 req/min, 1,000 req/day, 8K tokens/min, 200K tokens/day · no card',
  cerebras: '5 req/min, 1M tokens/day · no card',
  mistral: '1 req/s, 500K tokens/min, 1B tokens/month per model · phone check, requests may be used for training',
  nvidia: 'about 40 req/min (community-reported), for prototyping · no card',
  sambanova: '20 req/min, 20 req/day, 200K tokens/day · no card',
  openrouter: '20 req/min, 50 req/day on :free models (1,000/day after a $10 top-up) · no card',
  cloudflare: '10,000 neurons/day · no card; needs the account ID too',
  cohere: '1,000 calls/month on a trial key · no card',
  puter: 'your Puter account’s free monthly allowance (size not published)',
  pollinations: 'no key: 1 reply per 30 s per IP; a free key raises the limit',
  ollama: 'runs on this computer, unlimited, no key',
  custom: 'any OpenAI-compatible endpoint, e.g. FreeLLMAPI on http://localhost:3001/v1 (FREE-ROUTING.md)',
};

const LINK_TTL_MS = 6 * 3600 * 1000;
const PROTECTED = new Set([401, 403, 429]);
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,40}$/;

export function linkVerdict(status, error) {
  if (error) return { ok: false, detail: error };
  if (status < 400) return { ok: true, detail: `HTTP ${status}` };
  if (PROTECTED.has(status)) return { ok: true, detail: `HTTP ${status}: page exists, sign-in or bot check` };
  return { ok: false, detail: `HTTP ${status}` };
}

export class LinkVerifier {
  constructor({ fetchImpl = fetch, now = () => Date.now(), ttlMs = LINK_TTL_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  async check(url) {
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < this.ttlMs) return hit;
    let verdict;
    try {
      const res = await this.fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0 free-research-llm link check' } });
      verdict = linkVerdict(res.status);
      await res.body?.cancel?.();
    } catch (error) {
      verdict = linkVerdict(0, error.name === 'TimeoutError' ? 'timed out' : error.message);
    }
    const record = { ...verdict, at: this.now() };
    this.cache.set(url, record);
    return record;
  }

  async checkAll(urls, { force = false } = {}) {
    if (force) for (const u of urls) this.cache.delete(u);
    const out = {};
    await Promise.all([...new Set(urls)].map(async (u) => (out[u] = await this.check(u))));
    return out;
  }

  known(url) {
    return this.cache.get(url) ?? null;
  }
}

export function modelOrder(env) {
  const listed = String(env.FRL_PROVIDER_ORDER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const all = ROUTE_ORDER.deep.filter((id) => PROVIDER_PRESETS.some((p) => p.id === id));
  const extra = PROVIDER_PRESETS.map((p) => p.id).filter((id) => !all.includes(id));
  const enabled = listed.length ? listed.filter((id) => PROVIDER_PRESETS.some((p) => p.id === id)) : [...all, ...extra];
  return { enabled, disabled: [...all, ...extra].filter((id) => !enabled.includes(id)), custom: listed.length > 0 };
}

function stateOf(status, saved) {
  if (!status) return saved ? { state: 'failed', detail: 'saved, but the provider did not load' } : { state: 'empty', detail: 'no key yet' };
  if (status.coolingDownMs > 0) return { state: 'cooling', detail: `cooling down ${Math.ceil(status.coolingDownMs / 1000)} s after a rate limit` };
  if (status.state === 'ready') return { state: 'ready', detail: `${status.modelCount} models · fast ${status.fast ?? '–'} · deep ${status.deep ?? '–'}` };
  return { state: saved ? 'failed' : 'empty', detail: status.detail || (saved ? 'not working' : 'no key yet') };
}

export function catalogRows({ env, statuses = [], ledger = [], links = {} }) {
  const order = modelOrder(env);
  const calls = (id) => {
    const rows = ledger.filter((r) => r.provider === id);
    return { ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length };
  };
  const models = PROVIDER_PRESETS.map((p) => {
    const saved = Boolean((p.keyEnv && env[p.keyEnv]) || (p.baseEnv && env[p.baseEnv]));
    const status = statuses.find((s) => s.id === p.id);
    return {
      kind: 'model',
      id: p.id,
      label: p.label,
      env: p.keyEnv ?? null,
      accountEnv: p.accountEnv ?? null,
      baseEnv: p.baseEnv ?? null,
      modelEnv: p.modelEnv ?? null,
      signup: p.signup || null,
      link: p.signup ? links[p.signup] ?? null : null,
      free: FREE_TIERS[p.id] ?? '',
      saved,
      keyless: !p.keyEnv,
      enabled: order.enabled.includes(p.id),
      rank: order.enabled.indexOf(p.id),
      calls: calls(p.id),
      ...stateOf(status, saved),
    };
  });
  const search = SEARCH_KEYS.map((k) => ({
    kind: 'search',
    id: k.env,
    label: k.label,
    env: k.env,
    signup: k.signup,
    link: k.signup ? links[k.signup] ?? null : null,
    free: '',
    saved: Boolean(env[k.env]),
    state: env[k.env] ? 'saved' : 'empty',
    detail: env[k.env] ? 'saved; Test checks it with one search' : 'no key yet',
  }));
  return { models, search, order: order.enabled, orderIsCustom: order.custom, overrides: ['FRL_FAST_ORDER', 'FRL_DEEP_ORDER'].filter((n) => env[n]), freeTiersChecked: FREE_TIERS_CHECKED };
}

export function editableNames() {
  const names = new Set(SEARCH_KEYS.map((k) => k.env));
  for (const p of PROVIDER_PRESETS) for (const n of [p.keyEnv, p.accountEnv, p.baseEnv, p.modelEnv]) if (n) names.add(n);
  return names;
}

export class RouterAdmin {
  constructor({ env, secrets, reload, statuses, ledger, applyOrder, checker = new KeyChecker(), links = new LinkVerifier() }) {
    this.env = env;
    this.secrets = secrets;
    this.reload = reload;
    this.statuses = statuses;
    this.ledger = ledger;
    this.applyOrder = applyOrder;
    this.checker = checker;
    this.links = links;
  }

  urls() {
    return [...PROVIDER_PRESETS.map((p) => p.signup), ...SEARCH_KEYS.map((k) => k.signup)].filter((u) => /^https:\/\//.test(u ?? ''));
  }

  async view({ verify = false } = {}) {
    if (verify) await this.links.checkAll(this.urls(), { force: true });
    else void this.links.checkAll(this.urls()).catch(() => {});
    const links = Object.fromEntries(this.urls().map((u) => [u, this.links.known(u)]));
    return { ...catalogRows({ env: this.env, statuses: this.statuses(), ledger: this.ledger(), links }), store: this.secrets?.label ?? 'this session only (no key store)' };
  }

  guard(name) {
    if (!SECRET_NAME.test(String(name)) || !editableNames().has(name)) throw new RangeError(`unknown key name ${name}`);
  }

  async save(name, raw, { force = false } = {}) {
    this.guard(name);
    const plain = /_(BASE_URL|MODEL)$/.test(name) || name === 'SEARXNG_URL';
    const verdict = plain ? { ok: null, detail: 'setting saved', value: String(raw ?? '').trim() } : await this.checker.verify(name, raw);
    if (!verdict.value) throw new RangeError('nothing to save: the field is empty');
    if (verdict.ok === false && !force) return { saved: false, ok: false, detail: [verdict.detail, verdict.hint].filter(Boolean).join(' · ') };
    const stored = this.secrets ? await this.secrets.write(name, verdict.value) : false;
    this.env[name] = verdict.value;
    await this.reload();
    return { saved: true, stored, ok: verdict.ok, detail: verdict.repaired ? `repaired: ${verdict.repaired}` : verdict.detail };
  }

  async test(name) {
    this.guard(name);
    const value = this.env[name];
    if (!value) return { ok: false, detail: 'no key saved' };
    const verdict = await this.checker.verify(name, value);
    return { ok: verdict.ok, detail: [verdict.detail, verdict.hint].filter(Boolean).join(' · ') };
  }

  async remove(name) {
    this.guard(name);
    const removed = this.secrets ? await this.secrets.remove(name) : false;
    delete this.env[name];
    this.secrets?.loaded?.delete?.(name);
    await this.reload();
    return { removed: removed || true };
  }

  async order(ids) {
    const known = new Set(PROVIDER_PRESETS.map((p) => p.id));
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => known.has(id)))];
    if (!list.length) throw new RangeError('keep at least one provider on');
    const value = list.join(',');
    if (this.secrets) await this.secrets.write('FRL_PROVIDER_ORDER', value);
    this.env.FRL_PROVIDER_ORDER = value;
    this.applyOrder();
    await this.reload();
    return { order: list };
  }
}
