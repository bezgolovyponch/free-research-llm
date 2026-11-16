export const STAGE_CAPS = { scoping: 50, purpose: 48, tree: 90, evidence: 200 };
export const EXHAUSTIVE_CAP = 25;
export const EXHAUSTIVE_CHUNK = 5;
export const NONE = 'N';
export const DRAFT_PURPOSE = 'purpose-draft';
export const JUDGE_PURPOSE = 'purpose-judge';
export const SAMPLE_TEMPERATURE = 0.7;
export const DRAFT_TEMPERATURE = 0.2;

const LETTERS = 'ABCDEFGHIJKLM';

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

async function attempt({ router, task, tier = 'fast', messages, schema, avoid, temperature, budget, stage }) {
  const purpose = tier === 'deep' ? DRAFT_PURPOSE : JUDGE_PURPOSE;
  const heat = temperature ?? (tier === 'deep' ? DRAFT_TEMPERATURE : 0);
  const calls = [];
  let asked = messages;
  for (let round = 0; round < 2; round++) {
    if (budget && !budget.take(stage)) return { value: null, calls, skipped: true };
    let reply = null;
    try {
      reply = await router.complete({ purpose, tier, temperature: heat, messages: asked, avoid, task });
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

export async function vote({ n = 3, quorum = 2, key = (value) => JSON.stringify(value), avoidSame = true, messages, normalize = (value) => value, ...request }) {
  const purpose = request.tier === 'deep' ? DRAFT_PURPOSE : JUDGE_PURPOSE;
  const replies = [];
  const tally = {};
  const used = [];
  let winner = null;
  for (let index = 0; index < n && winner === null; index++) {
    const result = await attempt({ ...request, messages: typeof messages === 'function' ? messages(index) : messages, avoid: avoidSame && used.length ? [...used] : undefined });
    recordCalls(request.router, result.calls.filter((call) => !call.valid), purpose, () => false);
    if (result.value === null) continue;
    if (result.provider) used.push(result.provider);
    const value = normalize(result.value, index);
    const name = key(value);
    replies.push({ value, key: name, provider: result.provider, model: result.model });
    tally[name] = (tally[name] ?? 0) + 1;
    if (tally[name] >= quorum) winner = name;
  }
  for (const reply of replies) if (reply.provider) request.router.recordOutcome?.({ provider: reply.provider, model: reply.model, purpose, passed: winner !== null && reply.key === winner });
  return { value: winner === null ? null : replies.find((reply) => reply.key === winner).value, tally, replies };
}

function lettered(shortlist, index, fixed) {
  if (fixed) return shortlist.map((candidate) => ({ letter: candidate.letter, candidate }));
  const turn = shortlist.length ? index % shortlist.length : 0;
  const order = [...shortlist.slice(turn), ...shortlist.slice(0, turn)];
  return order.map((candidate, at) => ({ letter: LETTERS[at], candidate }));
}

export async function retrieveThenVerify({ query, candidates, k = 3, extra = [], embedder = null, router, prompt, schema = null, field = 'pick', votes = 3, quorum = 2, pairwise = false, fixed = false, none = NONE, keyOf = (id, more) => `${id ?? none}|${JSON.stringify(more ?? {})}`, task, tier = 'fast', budget = null, stage = null }) {
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
      const result = await vote({ ...request, n: votes, quorum, messages: prompt({ query, candidate }), schema });
      pairs.push({ candidate, value: result.value, tally: result.tally });
    }
    return { picked: pairs.filter((pair) => pair.value !== null).map((pair) => pair.candidate), pairs, tally: {}, shortlist, exhaustive };
  }
  const judge = (options) => selectOnce({ shortlist: options, query, prompt, schema, field, votes, quorum, keyOf, fixed, none, request });
  if (!shortlist.length) return { picked: null, extra: null, none: false, tally: {}, shortlist, exhaustive };
  let final = shortlist;
  if (exhaustive && shortlist.length > EXHAUSTIVE_CHUNK) {
    const winners = [];
    for (let at = 0; at < shortlist.length; at += EXHAUSTIVE_CHUNK) {
      const chunk = await judge(shortlist.slice(at, at + EXHAUSTIVE_CHUNK));
      if (chunk.value?.id !== null && chunk.value?.id !== undefined) winners.push(byId.get(chunk.value.id));
    }
    if (!winners.length) return { picked: null, extra: null, none: true, tally: {}, shortlist, exhaustive };
    final = winners;
  }
  const result = await judge(final);
  const picked = result.value?.id !== null && result.value?.id !== undefined ? byId.get(result.value.id) : null;
  return { picked, extra: result.value?.extra ?? null, none: Boolean(result.value && result.value.id === null), tally: result.tally, shortlist, exhaustive };
}

async function selectOnce({ shortlist, query, prompt, schema, field, votes, quorum, keyOf, fixed, none, request }) {
  let at = 0;
  return vote({
    ...request,
    n: votes,
    quorum,
    messages: (index) => {
      at = index;
      return prompt({ query, options: lettered(shortlist, index, fixed).map((option) => ({ letter: option.letter, text: option.candidate.text })), none });
    },
    schema: (data) => {
      const options = lettered(shortlist, at, fixed);
      const letter = String(data?.[field] ?? '').trim().toUpperCase();
      const hit = options.find((option) => option.letter === letter);
      if (letter !== none && !hit) return { error: `"${field}" must be one of ${options.map((option) => option.letter).join(', ')} or ${none}` };
      const more = schema ? schema(data, hit?.candidate ?? null) : { value: {} };
      if (more?.error !== undefined) return more;
      return { value: { id: hit ? hit.candidate.id : null, extra: more?.value ?? {} } };
    },
    key: (value) => keyOf(value.id, value.extra),
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
