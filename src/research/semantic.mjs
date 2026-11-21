import { CHOICE_LETTERS, replyFamily, sameFamily } from '../llm/ranking.mjs';

export const STAGE_CAPS ={ scoping: 50, purpose: 48, tree: 90, evidence: 200 };
export const EXHAUSTIVE_CAP = 25;
export const EXHAUSTIVE_CHUNK = 5;
export const NONE = 'N';
export const DRAFT_PURPOSE = 'purpose-draft';
export const JUDGE_PURPOSE = 'purpose-judge';
export const SAMPLE_TEMPERATURE = 0.7;
export const DRAFT_TEMPERATURE = 0.2;

const LETTERS = CHOICE_LETTERS;
export const SINGLE_REASON = 'one independent judgement only: fewer than two provider families answered';

export function agreed(result) {
  return result && !result.single ? result.value ?? null : null;
}

export function turnOf(seed) {
  let hash = 2166136261;
  for (const char of String(seed ?? '')) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash;
}

export function rotate(options, turn = 0) {
  const list = options ?? [];
  const shift = list.length ? turn % list.length : 0;
  return [...list.slice(shift), ...list.slice(0, shift)].map((option, at) => ({ ...option, letter: LETTERS[at] }));
}

export class CallBudget {
  constructor(caps = STAGE_CAPS) {
    this.caps = { ...caps };
    this.used = {};
    this.skipped = {};
  }

  take(stage) {
    if (!stage) return true;
    const cap = this.caps[stage] ?? Infinity;
    if ((this.used[stage] ?? 0) >= cap) {
      this.skipped[stage] = (this.skipped[stage] ?? 0) + 1;
      return false;
    }
    this.used[stage] = (this.used[stage] ?? 0) + 1;
    return true;
  }

  report() {
    const stages = [...new Set([...Object.keys(this.used), ...Object.keys(this.skipped)])];
    return Object.fromEntries(stages.map((stage) => [stage, { used: this.used[stage] ?? 0, cap: this.caps[stage] ?? null, skipped: this.skipped[stage] ?? 0 }]));
  }

  note() {
    const over = Object.entries(this.report()).filter(([, row]) => row.skipped > 0);
    return over.length ? `call budget reached: ${over.map(([stage, row]) => `${stage} stopped at ${row.cap} calls, ${row.skipped} judgement(s) left as unknown`).join('; ')}` : '';
  }
}

export function oneOf(value, options) {
  const text = String(value ?? '').trim().toUpperCase();
  return options.includes(text) ? text : null;
}

export function idOf(value, known) {
  const text = String(value ?? '').trim().replace(/^\[|\]$/g, '').toUpperCase();
  return known.has(text) ? text : null;
}

export function shortText(value, maxWords, maxChars = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().split(' ').slice(0, maxWords).join(' ').slice(0, maxChars);
}

async function attempt({ router, task, tier = 'fast', messages, schema, avoid, temperature, budget, stage, choice = null, apart = false }) {
  const purpose = tier === 'deep' ? DRAFT_PURPOSE : JUDGE_PURPOSE;
  const heat = temperature ?? (tier === 'deep' ? DRAFT_TEMPERATURE : 0);
  const calls = [];
  let asked = messages;
  for (let round = 0; round < 2; round++) {
    if (budget && !budget.take(stage)) return { value: null, calls, skipped: true };
    let reply = null;
    try {
      reply = await router.complete({ purpose, tier, temperature: heat, messages: asked, avoid, task, ...(choice ? { choice } : {}), ...(apart ? { apart: true } : {}) });
    } catch {
      reply = null;
    }
    if (!reply) return { value: null, calls };
    const checked = schema(reply.data);
    const call = { provider: reply.provider ?? null, model: reply.model ?? null, valid: checked?.error === undefined && checked?.value !== undefined && checked?.value !== null };
    calls.push(call);
    if (call.valid) return { value: checked.value, provider: call.provider, model: call.model, calls };
    asked = [...messages, { role: 'user', content: `Your last answer was not accepted: ${checked?.error ?? 'it does not follow the JSON format'}. Answer again with JSON only, in the exact format asked.` }];
  }
  return { value: null, calls };
}

function recordCalls(router, calls, purpose, passed) {
  for (const call of calls) if (call.provider) router.recordOutcome?.({ provider: call.provider, model: call.model, purpose, passed: passed(call) });
}

export async function ask(request) {
  const result = await attempt(request);
  recordCalls(request.router, result.calls, request.tier === 'deep' ? DRAFT_PURPOSE : JUDGE_PURPOSE, (call) => call.valid);
  return result.value === null ? null : { value: result.value, provider: result.provider, model: result.model };
}

export async function spreadSamples(router, request, n) {
  const sample = (extra = {}) => router.complete({ ...request, ...extra }).catch(() => null);
  const leads = process.env.FRL_SAMPLES_APART ? router.familyLeads?.({ tier: request.tier, purpose: request.purpose }) ?? [] : [];
  if (!leads.length) return Promise.all(Array.from({ length: n }, () => sample()));
  return Promise.all(Array.from({ length: n }, async (_, at) => {
    if (at < leads.length) return sample(leads.length > 1 ? { avoid: leads.filter((id) => id !== leads[at]) } : {});
    return (await sample({ avoid: leads, apart: true })) ?? sample();
  }));
}

export async function vote({ n = 3, quorum = 2, key = (value) => JSON.stringify(value), avoidSame = true, messages, schema, choice = null, exclude = [], normalize = (value) => value, ...request }) {
  const tier = request.tier ?? 'fast';
  const purpose = tier === 'deep' ? DRAFT_PURPOSE : JUDGE_PURPOSE;
  const router = request.router;
  const familyOf = (reply) => router.familyOf?.(reply.provider, { tier, model: reply.model }) ?? replyFamily(reply.model, reply.provider ?? '');
  const counted = (exclude ?? []).filter((entry) => entry?.provider || entry?.model).map(familyOf);
  const apart = Boolean(process.env.FRL_VOTE_APART);
  const reachable = router.families?.({ tier, purpose, ...(apart && router.maxWaitMs > 0 ? { within: router.maxWaitMs } : {}) }) ?? null;
  const open = reachable ? reachable.filter((family) => !counted.some((other) => sameFamily(other, family))) : null;
  const rounds = open && open.length < Math.max(1, Math.min(2, quorum)) ? Math.min(1, n) : n;
  const replies = [];
  const repeats = [];
  const tally = {};
  const used = [...(request.avoid ?? [])];
  let winner = null;
  for (let index = 0; index < rounds && winner === null; index++) {
    const result = await attempt({ ...request, schema: (data) => schema(data, index), choice: typeof choice === 'function' ? choice(index) : choice, messages: typeof messages === 'function' ? messages(index) : messages, avoid: avoidSame && used.length ? [...used] : undefined, ...(apart && avoidSame && used.length ? { apart: true } : {}) });
    recordCalls(router, result.calls.filter((call) => !call.valid), purpose, () => false);
    if (result.value === null && apart && avoidSame && used.length && !result.calls.length) break;
    if (result.value === null) continue;
    if (result.provider) used.push(result.provider);
    const value = normalize(result.value, index);
    const reply = { value, key: key(value), provider: result.provider, model: result.model };
    const family = familyOf(reply);
    if (counted.some((other) => sameFamily(other, family))) {
      repeats.push(reply);
      if (avoidSame) break;
      continue;
    }
    counted.push(family);
    replies.push(reply);
    tally[reply.key] = (tally[reply.key] ?? 0) + 1;
    if (tally[reply.key] >= quorum) winner = reply.key;
  }
  if (winner !== null) for (const reply of [...replies, ...repeats]) if (reply.provider) router.recordOutcome?.({ provider: reply.provider, model: reply.model, purpose, passed: reply.key === winner });
  const single = winner === null && ((quorum > 1 && replies.length === 1) || (replies.length === 0 && repeats.length > 0));
  const value = winner !== null ? replies.find((reply) => reply.key === winner).value : single ? (replies[0] ?? repeats[0]).value : null;
  return { value, ...(single ? { single: true } : {}), tally, replies, repeats };
}

export async function closedVote({ options, field, none = null, seed = '', prompt, extra = null, keyOf = (id) => String(id ?? none), ...request }) {
  const list = (options ?? []).slice(0, LETTERS.length);
  const start = turnOf(`${seed}|${list.map((option) => option.text).join('|')}`);
  const shown = (index) => rotate(list, start + index);
  return vote({
    ...request,
    choice: (index) => ({ field, options: list.length, ids: shown(index).map((option) => option.id) }),
    messages: (index) => prompt(shown(index)),
    schema: (data, index) => {
      const letters = shown(index);
      const letter = String(data?.[field] ?? '').trim().toUpperCase();
      const hit = letters.find((option) => option.letter === letter);
      if (!hit && !(none && letter === none)) return { error: `"${field}" must be one of ${letters.map((option) => option.letter).join(', ')}${none ? ` or ${none}` : ''}` };
      const more = extra ? extra(data, hit ?? null) : { value: {} };
      if (more?.error !== undefined) return more;
      return { value: { id: hit ? hit.id : null, extra: more?.value ?? {} } };
    },
    key: (value) => keyOf(value.id, value.extra),
  });
}

export async function retrieveThenVerify({ query, candidates, k = 3, extra = [], embedder = null, router, prompt, schema = null, field = 'pick', votes = 3, quorum = 2, pairwise = false, options = null, fixed = false, none = NONE, keyOf = (id, more) => `${id ?? none}|${JSON.stringify(more ?? {})}`, task, tier = 'fast', budget = null, stage = null }) {
  const list = (candidates ?? []).filter((candidate) => candidate && candidate.id !== undefined);
  const byId = new Map(list.map((candidate) => [candidate.id, candidate]));
  const first = extra.map((id) => byId.get(id)).filter(Boolean);
  const rest = list.filter((candidate) => !first.includes(candidate));
  const ranked = fixed || !rest.length ? null : embedder ? await embedder.rank(query, rest.map((candidate) => candidate.text), k) : null;
  const exhaustive = !fixed && rest.length > 0 && !ranked;
  const shortlist = fixed ? list : exhaustive ? [...first, ...rest].slice(0, EXHAUSTIVE_CAP) : [...first, ...(ranked?.order ?? []).map((index) => rest[index])];
  const request = { router, task, tier, budget, stage };
  if (pairwise) {
    const pairs = [];
    for (const candidate of shortlist) {
      const result = options
        ? await closedVote({ ...request, n: votes, quorum, options, field, seed: `${query}|${candidate.text}`, prompt: (shown) => prompt({ query, candidate, options: shown }), keyOf: (id) => String(id) })
        : await vote({ ...request, n: votes, quorum, messages: prompt({ query, candidate }), schema });
      const value = options ? agreed(result)?.id ?? null : agreed(result);
      pairs.push({ candidate, value, tally: result.tally, ...(result.single ? { single: true } : {}) });
    }
    return { picked: pairs.filter((pair) => pair.value !== null).map((pair) => pair.candidate), pairs, tally: {}, shortlist, exhaustive };
  }
  const judge = (shown) => selectOnce({ shortlist: shown, query, prompt, schema, field, votes, quorum, keyOf, none, request });
  if (!shortlist.length) return { picked: null, extra: null, none: false, tally: {}, shortlist, exhaustive };
  let final = shortlist;
  if (exhaustive && shortlist.length > EXHAUSTIVE_CHUNK) {
    const winners = [];
    for (let at = 0; at < shortlist.length; at += EXHAUSTIVE_CHUNK) {
      const chunk = agreed(await judge(shortlist.slice(at, at + EXHAUSTIVE_CHUNK)));
      if (chunk?.id !== null && chunk?.id !== undefined) winners.push(byId.get(chunk.id));
    }
    if (!winners.length) return { picked: null, extra: null, none: true, tally: {}, shortlist, exhaustive };
    final = winners;
  }
  const result = await judge(final);
  const settled = agreed(result);
  const picked = settled?.id !== null && settled?.id !== undefined ? byId.get(settled.id) : null;
  const leaning = result.single && result.value?.id !== null && result.value?.id !== undefined ? byId.get(result.value.id) : null;
  return { picked, extra: settled?.extra ?? null, none: Boolean(settled && settled.id === null), tally: result.tally, shortlist, exhaustive, ...(result.single ? { single: true, leaning } : {}) };
}

async function selectOnce({ shortlist, query, prompt, schema, field, votes, quorum, keyOf, none, request }) {
  const byId = new Map(shortlist.map((candidate) => [candidate.id, candidate]));
  return closedVote({
    ...request,
    n: votes,
    quorum,
    options: shortlist.map((candidate) => ({ id: candidate.id, text: candidate.text })),
    field,
    none,
    seed: query,
    prompt: (shown) => prompt({ query, options: shown.map((option) => ({ letter: option.letter, text: option.text })), none }),
    extra: schema ? (data, hit) => schema(data, hit ? byId.get(hit.id) : null) : null,
    keyOf,
  });
}

export function optionLines(options, none, noneText = 'none of these') {
  return [...options.map((option) => `${option.letter}) ${option.text}`), ...(none ? [`${none}) ${noneText}`] : [])].join('\n');
}

export function matchPrompt(what) {
  return ({ query, options, none }) => [
    { role: 'system', content: `You compare short texts by meaning, in any language. Pick the option that names the same ${what} as the text, or ${none} when none does. Answer with JSON only: {"pick":"<one letter>"}.` },
    { role: 'user', content: `Text: ${query}\n\nOptions:\n${optionLines(options, none)}` },
  ];
}

export async function agreeAcrossSamples({ samples, textOf, sameKey = null, minSamples = 2, embedder = null, router, prompt, task, budget = null, stage = null }) {
  const clusters = [];
  for (const [sample, items] of samples.entries()) {
    for (const item of items) {
      const open = clusters.filter((cluster) => !cluster.samples.has(sample) && (!sameKey || sameKey(cluster.items[0]) === sameKey(item)));
      const exact = open.find((cluster) => cluster.items.some((other) => textOf(other).trim().toLowerCase() === textOf(item).trim().toLowerCase()));
      let home = exact ?? null;
      if (!home && open.length) {
        const match = await retrieveThenVerify({ query: textOf(item), candidates: open.map((cluster, id) => ({ id, text: textOf(cluster.items[0]) })), embedder, router, prompt, task, budget, stage });
        home = match.picked ? open[match.picked.id] : null;
      }
      if (home) {
        home.items.push(item);
        home.samples.add(sample);
      } else clusters.push({ items: [item], samples: new Set([sample]) });
    }
  }
  return clusters.filter((cluster) => cluster.samples.size >= minSamples).map((cluster) => ({ item: cluster.items[0], items: cluster.items, samples: cluster.samples.size }));
}
