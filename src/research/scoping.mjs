import { regionVerdict } from './brief.mjs';
import { COST_BASIS, COST_GOAL, COST_ROLE, VALUE_BASIS, VALUE_GOAL, VALUE_ROLE } from './purpose.mjs';
import { pickSpans, quoteFromSpans, sentenceSpans, spansBlock } from './spans.mjs';
import { SAMPLE_TEMPERATURE, agreeAcrossSamples, ask, matchPrompt, oneOf, shortText, vote } from './semantic.mjs';

export const STAGE = 'scoping';
export const MAX_SOURCES = 12;
export const MAX_QUERIES = 12;
export const MAX_NOTES_PER_SOURCE = 4;
export const MIN_HOSTS = 4;
export const MIN_PERSPECTIVES = 2;
export const SCOPING_BASE_CAP = 20;
export const SCOPING_CALLS_PER_SOURCE = 5;
export const THIN = 'scoping thin';
export const SUBJECT_LABELS = 5;
export const SUBJECT_CHARS = 400;
export const RELEVANCE_SPANS = 8;
export const NOTE_SPANS = 40;
export const BLOCK_CHARS = 4000;
export const PAGE_CHARS = 40000;
export const ABOUT = { A: 'the asked subject', B: 'the wider class it belongs to', C: 'a different subject', D: 'not informative' };
export const MARKET = { A: 'describes the asked market', B: 'holds in any market', C: 'describes another market' };
export const KNOWLEDGE = 'knowledge';
export const MARKET_ROLE = 'market';
export const UNDECIDED = 'undecided';
export const OFF_MARKET = 'off-market';
export const ROLES = { A: KNOWLEDGE, B: MARKET_ROLE };
export const ROLE_TEXT = { A: 'explains how to judge or choose such a thing: what decides, methods, criteria, risks, whatever place it describes', B: 'describes a market: offers, prices, availability or local rules' };
export const FIXED_VIEWS = [
  { role: VALUE_ROLE, name: VALUE_GOAL, basis: VALUE_BASIS, asks: 'what the result must do for the purpose, and how a careful decision-maker tells a good one from a poor one', fallback: 'how to choose' },
  { role: COST_ROLE, name: COST_GOAL, basis: COST_BASIS, asks: 'everything it takes to obtain and use the result, from finding it to living with it', fallback: 'total cost' },
];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url ?? '');
  }
};

export { hostOf };

export function pageKey(url) {
  try {
    const parsed = new URL(url);
    return `${hostOf(url).toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return String(url ?? '');
  }
}

export async function subjectLevels(ctx, { question, kind, titles = [] }) {
  if (!titles.length) return [kind];
  const messages = [
    { role: 'system', content: 'You name the attributes that decide the value of one kind of item. Read the listing titles and list 2 to 5 attribute names, from coarse to fine, at which buyers tell such items apart. Attribute names only, no values. Answer with JSON only: {"levels":["...","..."]}.' },
    { role: 'user', content: `Question: ${question}\nKind: ${kind}\n\nListing titles:\n${titles.slice(0, 20).map((title) => `- ${String(title).slice(0, 120)}`).join('\n')}` },
  ];
  const schema = (data) => {
    const levels = (Array.isArray(data?.levels) ? data.levels : []).map((level) => shortText(level, 4, 60)).filter(Boolean);
    return levels.length >= 2 && levels.length <= 5 ? { value: levels } : { error: '"levels" must hold 2 to 5 attribute names' };
  };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const reply = await ask({ router: ctx.router, task: 'subject-levels', tier: 'deep', temperature: SAMPLE_TEMPERATURE, messages, schema, budget: ctx.budget, stage: STAGE });
    if (reply) samples.push(reply.value);
  }
  const agreed = await agreeAcrossSamples({ samples, textOf: (level) => level, embedder: ctx.embedder, router: ctx.router, prompt: matchPrompt('attribute'), task: 'subject-levels-match', budget: ctx.budget, stage: STAGE });
  return agreed.length ? agreed.map((entry) => entry.item) : [kind];
}

export function scopingCap(sources = MAX_SOURCES) {
  return SCOPING_BASE_CAP + Math.max(0, Number(sources) || 0) * SCOPING_CALLS_PER_SOURCE;
}

function planScoping(ctx) {
  if (!ctx.budget?.caps) return;
  ctx.budget.caps[STAGE] = scopingCap();
  ctx.log?.(`scoping budget: ${ctx.budget.caps[STAGE]} calls (${SCOPING_BASE_CAP} for levels and perspectives, ${SCOPING_CALLS_PER_SOURCE} for each of ${MAX_SOURCES} source(s): one judgement, up to 3 role votes, one set of notes)`);
}

function sourcesAffordable(ctx) {
  if (!ctx.budget?.caps) return MAX_SOURCES;
  const left = (ctx.budget.caps[STAGE] ?? Infinity) - (ctx.budget.used?.[STAGE] ?? 0);
  return Math.max(0, Math.min(MAX_SOURCES, Math.floor(left / SCOPING_CALLS_PER_SOURCE)));
}

function aspectsOf(list, languages) {
  const perLanguage = {};
  const aspects = [];
  for (const aspect of Array.isArray(list) ? list : []) {
    const lang = languages.find((language) => language.toLowerCase() === String(aspect?.lang ?? '').trim().toLowerCase());
    const phrase = shortText(aspect?.phrase, 6, 80);
    if (!lang || !phrase || (perLanguage[lang] ?? 0) >= 2) continue;
    perLanguage[lang] = (perLanguage[lang] ?? 0) + 1;
    aspects.push({ lang, phrase });
  }
  return aspects;
}

export async function fixedPerspectives(ctx, { question, purpose = '', languages = ['English'] }) {
  const messages = [
    { role: 'system', content: `You plan a scoping review. Two perspectives are fixed: ${FIXED_VIEWS.map((view) => `"${view.role}": ${view.asks}`).join('; ')}. For each of the two give short aspect phrases (at most 6 words, no subject name, no place name) in the listed languages, at most 2 per language, each written in that language. Every listed language needs at least one phrase for each perspective. Answer with JSON only: {${FIXED_VIEWS.map((view) => `"${view.role}":[{"lang":"<one of the languages>","phrase":"..."}]`).join(',')}}.` },
    { role: 'user', content: `Question: ${question}\nPurpose: ${purpose || question}\nLanguages: ${languages.join(', ')}` },
  ];
  const schema = (data) => {
    const value = {};
    for (const view of FIXED_VIEWS) {
      value[view.role] = aspectsOf(data?.[view.role], languages);
      const covered = new Set(value[view.role].map((aspect) => aspect.lang));
      const missing = languages.filter((language) => !covered.has(language));
      if (missing.length) return { error: `"${view.role}" has no aspect phrase in: ${missing.join(', ')}` };
    }
    return { value };
  };
  const reply = await ask({ router: ctx.router, task: 'fixed-perspectives', tier: 'deep', messages, schema, budget: ctx.budget, stage: STAGE });
  if (!reply) ctx.log?.(`scoping: no model phrased the ${FIXED_VIEWS.map((view) => view.role).join(' and ')} perspectives; each keeps one phrase set by code`);
  return FIXED_VIEWS.map((view) => ({ name: view.name, role: view.role, basis: view.basis, aspects: reply?.value[view.role] ?? [{ lang: languages[0] ?? 'English', phrase: view.fallback }], ...(reply ? {} : { fallback: true }) }));
}

export async function perspectives(ctx, { question, purpose = '', languages = ['English'], tried = [] }) {
  const messages = [
    { role: 'system', content: `You plan a scoping review. List at most 4 distinct expert perspectives a careful decision-maker would consult for the question. For each perspective give short aspect phrases (at most 6 words, no subject name, no place name) in the listed languages, at most 2 per language, each written in that language. Every listed language needs at least one phrase. Answer with JSON only: {"perspectives":[{"name":"...","aspects":[{"lang":"<one of the languages>","phrase":"..."}]}]}.` },
    { role: 'user', content: `Question: ${question}\nPurpose: ${purpose || question}\nLanguages: ${languages.join(', ')}${tried.length ? `\nPhrases already searched, give different ones: ${tried.join('; ')}` : ''}` },
  ];
  const schema = (data) => {
    const list = (Array.isArray(data?.perspectives) ? data.perspectives : []).slice(0, 4).map((entry) => ({ name: shortText(entry?.name, 6, 60), aspects: aspectsOf(entry?.aspects, languages) })).filter((entry) => entry.name && entry.aspects.length);
    const covered = new Set(list.flatMap((entry) => entry.aspects.map((aspect) => aspect.lang)));
    const missing = languages.filter((language) => !covered.has(language));
    if (!list.length) return { error: '"perspectives" is empty' };
    return missing.length ? { error: `no aspect phrase in: ${missing.join(', ')}` } : { value: list };
  };
  const reply = await ask({ router: ctx.router, task: 'perspectives', tier: 'deep', messages, schema, budget: ctx.budget, stage: STAGE });
  return reply?.value ?? [];
}

export function moreAspects(views, fresh) {
  const tried = new Set((views ?? []).flatMap((view) => view.aspects.map((aspect) => aspect.phrase.toLowerCase())));
  const out = (views ?? []).map((view) => ({ ...view }));
  for (const view of fresh ?? []) {
    const aspects = view.aspects.filter((aspect) => !tried.has(aspect.phrase.toLowerCase()));
    if (!aspects.length) continue;
    for (const aspect of aspects) tried.add(aspect.phrase.toLowerCase());
    const held = out.find((entry) => entry.name === view.name);
    if (held) held.aspects = [...held.aspects, ...aspects];
    else out.push({ name: view.name, aspects, round: 2 });
  }
  return out;
}

export function subjectLabels(rows, levels, kind) {
  const labels = [];
  for (let depth = 1; depth <= (levels ?? []).length; depth++) {
    const counts = new Map();
    for (const row of rows ?? []) {
      const values = (row?.subject ?? []).slice(0, depth);
      if (values.length < depth || values.some((value) => !value)) continue;
      const label = values.join(' ');
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    labels.push(...[...counts].sort((a, b) => b[1] - a[1]).slice(0, SUBJECT_LABELS).map(([label]) => label));
  }
  return labels.length ? [...new Set(labels)] : [kind].filter(Boolean);
}

export function askedSubject(kind, requirements) {
  const asked = (requirements ?? []).filter((anchor) => anchor?.kind === 'clause' && anchor.text).map((anchor) => String(anchor.text).replace(/\s+/g, ' ').trim()).join('; ').slice(0, SUBJECT_CHARS);
  if (!asked) return kind;
  return kind ? `${kind}, as asked: ${asked}` : asked;
}

export function screeningSubject(subjects, kind, requirements = []) {
  const labels = (subjects ?? []).filter((label) => label && label !== kind);
  if (!labels.length) return askedSubject(kind, requirements);
  return labels.length === 1 && !kind ? labels[0] : `${kind} (any of: ${labels.join('; ')})`;
}

export function composeQueries(subjects, perspectiveList, max = MAX_QUERIES, { used = [], first = [], shift = 0 } = {}) {
  const views = [...(perspectiveList ?? [])].sort((a, b) => Number(first.includes(b.name)) - Number(first.includes(a.name)));
  const byLanguage = new Map();
  let total = 0;
  for (const [order, view] of views.entries()) {
    const turnOf = {};
    for (const aspect of view.aspects) {
      const turn = turnOf[aspect.lang] ?? 0;
      turnOf[aspect.lang] = turn + 1;
      byLanguage.set(aspect.lang, [...(byLanguage.get(aspect.lang) ?? []), { ...aspect, perspective: view.name, turn, order }]);
      total += 1;
    }
  }
  for (const list of byLanguage.values()) list.sort((a, b) => a.turn - b.turn || a.order - b.order);
  const turns = [];
  for (let round = 0; turns.length < total; round++) for (const list of byLanguage.values()) if (list[round]) turns.push(list[round]);
  const queries = [];
  const seen = new Set(used);
  for (const [index, aspect] of turns.entries()) {
    if (queries.length >= max || !subjects?.length) break;
    const subject = subjects[(index + shift) % subjects.length];
    const query = `${subject} ${aspect.phrase}`;
    if (seen.has(query)) continue;
    seen.add(query);
    queries.push({ query, subject, lang: aspect.lang, perspective: aspect.perspective });
  }
  return queries;
}

export async function findSources(ctx, queries, { max = MAX_SOURCES, seen = [] } = {}) {
  const groups = new Map();
  for (const entry of queries ?? []) groups.set(entry.perspective, [...(groups.get(entry.perspective) ?? []), entry.query]);
  if (!groups.size || !ctx.search) return [];
  const share = Math.ceil(max / groups.size) + 1;
  const lists = [];
  for (const [perspective, list] of groups) {
    const found = await ctx.search.search(list, { maxSources: share }).catch(() => []);
    lists.push((Array.isArray(found) ? found : []).filter((source) => source?.url).map((source) => ({ source, perspective })));
  }
  const known = new Set([...seen].map(pageKey));
  const byUrl = new Map();
  for (let turn = 0; lists.some((list) => list[turn]); turn++) {
    for (const list of lists) {
      const hit = list[turn];
      const key = hit ? pageKey(hit.source.url) : '';
      if (!hit || known.has(key)) continue;
      const held = byUrl.get(key);
      if (held) held.perspectives = [...new Set([...held.perspectives, hit.perspective])];
      else byUrl.set(key, { ...hit.source, perspectives: [hit.perspective] });
    }
  }
  const hosts = new Set();
  const firstOfHost = [];
  const repeats = [];
  for (const source of byUrl.values()) {
    const host = hostOf(source.url);
    (hosts.has(host) ? repeats : firstOfHost).push(source);
    hosts.add(host);
  }
  return [...firstOfHost, ...repeats].slice(0, max);
}

export function diversityOf(sources) {
  const hosts = new Set((sources ?? []).map((source) => source.host ?? hostOf(source.url)));
  const views = new Set((sources ?? []).flatMap((source) => source.perspectives ?? []));
  return { hosts: hosts.size, perspectives: views.size, perspectiveNames: [...views], enough: hosts.size >= MIN_HOSTS && views.size >= MIN_PERSPECTIVES };
}

export async function judgeSource(ctx, { source, purpose, subject, markets = [], regions = [], avoid = undefined }) {
  const spans = sentenceSpans(source.text ?? source.snippet ?? '', { limit: PAGE_CHARS });
  const shown = await pickSpans(spans, `${purpose} ${subject}`, ctx.embedder, RELEVANCE_SPANS);
  if (!shown.length) return { verdict: null, reason: 'the page has no readable sentence', shown };
  const signal = regionVerdict(source, regions);
  const messages = [
    { role: 'system', content: `You screen one source for a research. Judge only from the sentences shown. "about": ${Object.entries(ABOUT).map(([letter, text]) => `${letter} ${text}`).join(', ')}. "market": ${Object.entries(MARKET).map(([letter, text]) => `${letter} ${text}`).join(', ')}. "span": the id of the one sentence that best shows it, or null. Answer with JSON only: {"about":"A|B|C|D","market":"A|B|C","span":"S<n>"}.` },
    { role: 'user', content: `Purpose: ${purpose}\nAsked subject: ${subject}\nAsked market: ${markets.length ? markets.join(', ') : 'any'}\nCountry signal read from the page address and text: ${signal ? signal.text : 'none'}\nSource title: ${String(source.title ?? '').slice(0, 160)}\n\nSentences:\n${spansBlock(shown, BLOCK_CHARS)}` },
  ];
  const schema = (data) => {
    const about = oneOf(data?.about, Object.keys(ABOUT));
    const market = oneOf(data?.market, Object.keys(MARKET));
    if (!about || !market) return { error: '"about" must be A, B, C or D and "market" must be A, B or C' };
    return { value: { about, market, span: data?.span ?? null } };
  };
  const reply = await ask({ router: ctx.router, task: 'source-relevance', tier: 'fast', messages, schema, avoid, budget: ctx.budget, stage: STAGE });
  if (!reply) return { verdict: null, reason: 'not judged', shown };
  const quote = quoteFromSpans(reply.value.span, shown);
  return { verdict: { about: reply.value.about, market: reply.value.market, span: quote ? String(reply.value.span).trim().replace(/^\[|\]$/g, '').toUpperCase() : null, quote }, provider: reply.provider, shown };
}

export async function sourceRole(ctx, { source, shown, purpose, subject }) {
  const letters = Object.keys(ROLES);
  const messages = [
    { role: 'system', content: `You classify one source for a research, in any language. Judge only from the sentences shown. "role": ${letters.map((letter) => `${letter} when the source ${ROLE_TEXT[letter]}`).join('; ')}. Answer with JSON only: {"role":"${letters.join('|')}"}.` },
    { role: 'user', content: `Purpose: ${purpose}\nAsked subject: ${subject}\nSource title: ${String(source.title ?? '').slice(0, 160)}\n\nSentences:\n${spansBlock(shown, BLOCK_CHARS)}` },
  ];
  const schema = (data) => {
    const role = oneOf(data?.role, letters);
    return role ? { value: role } : { error: `"role" must be ${letters.join(' or ')}` };
  };
  const result = await vote({ router: ctx.router, task: 'source-role', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => value, budget: ctx.budget, stage: STAGE });
  return { role: result.value ? ROLES[result.value] : UNDECIDED, votes: result.tally };
}

export function relevanceReason(verdict, role = MARKET_ROLE) {
  if (!verdict) return 'not judged';
  if (!['A', 'B'].includes(verdict.about)) return `off-subject: ${ABOUT[verdict.about]}`;
  if (role === MARKET_ROLE && !['A', 'B'].includes(verdict.market)) return `${OFF_MARKET}: ${MARKET[verdict.market]}`;
  if (!verdict.span) return 'no sentence on the page shows it';
  return '';
}

export async function screenSources(ctx, { sources, purpose, subject, markets = [], regions = [], limit = MAX_SOURCES }) {
  const kept = [];
  const dropped = [];
  for (const [index, source] of (sources ?? []).entries()) {
    if (index >= limit) {
      dropped.push({ url: source.url, reason: `not screened: over the limit of ${limit} sources` });
      continue;
    }
    const judged = await judgeSource(ctx, { source, purpose, subject, markets, regions });
    const early = judged.verdict ? relevanceReason(judged.verdict, KNOWLEDGE) : judged.reason;
    if (early) {
      dropped.push({ url: source.url, reason: early });
      continue;
    }
    const { role, votes } = await sourceRole(ctx, { source, shown: judged.shown, purpose, subject });
    const reason = relevanceReason(judged.verdict, role);
    if (reason) dropped.push({ url: source.url, reason, role, roleVotes: votes });
    else kept.push({ ...source, host: hostOf(source.url), about: judged.verdict.about, market: judged.verdict.market, span: judged.verdict.span, spanQuote: judged.verdict.quote, judgedBy: judged.provider ?? null, role, roleVotes: votes });
  }
  return { kept, dropped };
}

export async function scopeNotes(ctx, { sources, purpose }) {
  const notes = [];
  const rejected = [];
  for (const source of sources ?? []) {
    const spans = sentenceSpans(source.text ?? '', { limit: PAGE_CHARS }).slice(0, NOTE_SPANS);
    const block = spansBlock(spans, BLOCK_CHARS);
    if (!block) continue;
    const shown = spans.slice(0, block.split('\n').length);
    const messages = [
      { role: 'system', content: `You mark what a source treats as decisive for a purpose. Pick at most ${MAX_NOTES_PER_SOURCE} notes. Each note is one or two sentence ids from the list and a label of at most 8 words. Never write the sentence itself. Answer with JSON only: {"notes":[{"spans":["S4"],"label":"..."}]}.` },
      { role: 'user', content: `Purpose: ${purpose}\nSource: ${String(source.title ?? '').slice(0, 160)}\n\nSentences:\n${block}` },
    ];
    const schema = (data) => (Array.isArray(data?.notes) ? { value: data.notes.slice(0, MAX_NOTES_PER_SOURCE) } : { error: '"notes" must be a list' });
    const reply = await ask({ router: ctx.router, task: 'scope-notes', tier: 'fast', messages, schema, budget: ctx.budget, stage: STAGE });
    for (const note of reply?.value ?? []) {
      const quote = quoteFromSpans(note?.spans, shown);
      if (quote) notes.push({ id: `N${notes.length + 1}`, url: source.url, quote, label: shortText(note?.label, 8, 80) });
      else rejected.push({ url: source.url, reason: 'a sentence id that is not on the page' });
    }
  }
  return { notes, rejected };
}

export async function runScoping(ctx, { question, purpose = '', kind, regions = [], markets = [], languages = ['English'], rows = [], titles = [], requirements = [] }) {
  planScoping(ctx);
  const levels = await subjectLevels(ctx, { question, kind, titles });
  const subjects = subjectLabels(rows, levels, kind);
  let views = [...(await fixedPerspectives(ctx, { question, purpose, languages })), ...(await perspectives(ctx, { question, purpose, languages }))];
  const queries = composeQueries(subjects, views).map((entry) => ({ ...entry, round: 1 }));
  const screening = { purpose: purpose || question, subject: screeningSubject(subjects, kind, requirements), markets, regions };
  const found = await findSources(ctx, queries);
  const first = await screenSources(ctx, { sources: found, ...screening });
  const kept = [...first.kept];
  const dropped = [...first.dropped];
  let diversity = diversityOf(kept);
  let rounds = 1;
  if (!diversity.enough) {
    const state = `${THIN}: ${diversity.hosts} hosts across ${diversity.perspectives} perspectives (at least ${MIN_HOSTS} hosts across ${MIN_PERSPECTIVES} perspectives are needed)`;
    const compose = () => composeQueries(subjects, views, MAX_QUERIES, { used: queries.map((entry) => entry.query), first: views.map((view) => view.name).filter((name) => !diversity.perspectiveNames.includes(name)), shift: 1 }).map((entry) => ({ ...entry, round: 2 }));
    let more = compose();
    if (!more.length && sourcesAffordable(ctx)) {
      views = moreAspects(views, await perspectives(ctx, { question, purpose, languages, tried: views.flatMap((view) => view.aspects.map((aspect) => aspect.phrase)) }));
      more = compose();
    }
    const room = sourcesAffordable(ctx);
    if (!room) ctx.log?.(`${state}; no call budget is left for one more round of queries`);
    else if (!more.length) ctx.log?.(`${state}; no further query can be composed from the perspectives`);
    else {
      ctx.log?.(`${state}; one more round of ${more.length} queries, up to ${room} sources`);
      rounds = 2;
      queries.push(...more);
      const extra = await findSources(ctx, more, { max: room, seen: found.map((source) => source.url) });
      const again = await screenSources(ctx, { sources: extra, ...screening, limit: room });
      kept.push(...again.kept);
      dropped.push(...again.dropped);
      diversity = diversityOf(kept);
      if (!diversity.enough) ctx.log?.(`${THIN}: ${diversity.hosts} hosts across ${diversity.perspectives} perspectives after one more round of queries`);
    }
  }
  const noted = await scopeNotes(ctx, { sources: kept, purpose: purpose || question });
  const embedNote = ctx.embedder?.failureNote?.() ?? '';
  if (embedNote) ctx.log?.(embedNote);
  const scoping = {
    levels,
    languages,
    subjects,
    perspectives: views,
    queries,
    screened: { purpose: screening.purpose, subject: screening.subject },
    sources: kept.map((source) => ({ url: source.url, title: source.title ?? '', host: source.host, about: source.about, market: source.market, span: source.span, judgedBy: source.judgedBy, role: source.role, roleVotes: source.roleVotes, perspectives: source.perspectives ?? [] })),
    dropped,
    notes: noted.notes,
    rejectedNotes: noted.rejected,
    diversity: { hosts: diversity.hosts, perspectives: diversity.perspectives, minHosts: MIN_HOSTS, minPerspectives: MIN_PERSPECTIVES, rounds },
    enough: diversity.enough,
    embedModel: ctx.embedder?.lastModel ?? null,
    at: new Date().toISOString(),
  };
  return { scoping, pages: kept };
}
