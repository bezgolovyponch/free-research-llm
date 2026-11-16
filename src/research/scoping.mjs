import { regionVerdict } from './brief.mjs';
import { pickSpans, quoteFromSpans, sentenceSpans, spansBlock } from './spans.mjs';
import { SAMPLE_TEMPERATURE, agreeAcrossSamples, ask, matchPrompt, oneOf, shortText } from './semantic.mjs';

export const STAGE = 'scoping';
export const MAX_SOURCES = 12;
export const MAX_QUERIES = 12;
export const MAX_NOTES_PER_SOURCE = 4;
export const MIN_KEPT_SOURCES = 4;
export const SUBJECT_LABELS = 5;
export const RELEVANCE_SPANS = 8;
export const NOTE_SPANS = 40;
export const BLOCK_CHARS = 4000;
export const PAGE_CHARS = 40000;
export const ABOUT = { A: 'the asked subject', B: 'the wider class it belongs to', C: 'a different subject', D: 'not informative' };
export const MARKET = { A: 'describes the asked market', B: 'holds in any market', C: 'describes another market' };

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url ?? '');
  }
};

export { hostOf };

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

export async function perspectives(ctx, { question, purpose = '', languages = ['English'] }) {
  const messages = [
    { role: 'system', content: `You plan a scoping review. List at most 4 distinct expert perspectives a careful decision-maker would consult for the question. For each perspective give short aspect phrases (at most 6 words, no subject name, no place name) in the listed languages, at most 2 per language, each written in that language. Every listed language needs at least one phrase. Answer with JSON only: {"perspectives":[{"name":"...","aspects":[{"lang":"<one of the languages>","phrase":"..."}]}]}.` },
    { role: 'user', content: `Question: ${question}\nPurpose: ${purpose || question}\nLanguages: ${languages.join(', ')}` },
  ];
  const schema = (data) => {
    const list = (Array.isArray(data?.perspectives) ? data.perspectives : []).slice(0, 4).map((entry) => {
      const perLanguage = {};
      const aspects = [];
      for (const aspect of Array.isArray(entry?.aspects) ? entry.aspects : []) {
        const lang = languages.find((language) => language.toLowerCase() === String(aspect?.lang ?? '').trim().toLowerCase());
        const phrase = shortText(aspect?.phrase, 6, 80);
        if (!lang || !phrase || (perLanguage[lang] ?? 0) >= 2) continue;
        perLanguage[lang] = (perLanguage[lang] ?? 0) + 1;
        aspects.push({ lang, phrase });
      }
      return { name: shortText(entry?.name, 6, 60), aspects };
    }).filter((entry) => entry.name && entry.aspects.length);
    const covered = new Set(list.flatMap((entry) => entry.aspects.map((aspect) => aspect.lang)));
    const missing = languages.filter((language) => !covered.has(language));
    if (!list.length) return { error: '"perspectives" is empty' };
    return missing.length ? { error: `no aspect phrase in: ${missing.join(', ')}` } : { value: list };
  };
  const reply = await ask({ router: ctx.router, task: 'perspectives', tier: 'deep', messages, schema, budget: ctx.budget, stage: STAGE });
  return reply?.value ?? [];
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

export function screeningSubject(subjects, kind) {
  const labels = (subjects ?? []).filter((label) => label && label !== kind);
  if (!labels.length) return kind;
  return labels.length === 1 && !kind ? labels[0] : `${kind} (any of: ${labels.join('; ')})`;
}

export function composeQueries(subjects, perspectiveList, max = MAX_QUERIES) {
  const aspects = (perspectiveList ?? []).flatMap((perspective) => perspective.aspects.map((aspect) => ({ ...aspect, perspective: perspective.name })));
  const byLanguage = new Map();
  for (const aspect of aspects) byLanguage.set(aspect.lang, [...(byLanguage.get(aspect.lang) ?? []), aspect]);
  const turns = [];
  for (let round = 0; turns.length < aspects.length; round++) for (const list of byLanguage.values()) if (list[round]) turns.push(list[round]);
  const queries = [];
  const seen = new Set();
  for (const [index, aspect] of turns.entries()) {
    if (queries.length >= max || !subjects?.length) break;
    const subject = subjects[index % subjects.length];
    const query = `${subject} ${aspect.phrase}`;
    if (seen.has(query)) continue;
    seen.add(query);
    queries.push({ query, subject, lang: aspect.lang, perspective: aspect.perspective });
  }
  return queries;
}

export async function judgeSource(ctx, { source, purpose, subject, markets = [], regions = [], avoid = undefined }) {
  const spans = sentenceSpans(source.text ?? source.snippet ?? '', { limit: PAGE_CHARS });
  const shown = await pickSpans(spans, `${purpose} ${subject}`, ctx.embedder, RELEVANCE_SPANS);
  if (!shown.length) return { verdict: null, reason: 'the page has no readable sentence' };
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
  if (!reply) return { verdict: null, reason: 'not judged' };
  const quote = quoteFromSpans(reply.value.span, shown);
  return { verdict: { about: reply.value.about, market: reply.value.market, span: quote ? String(reply.value.span).trim().replace(/^\[|\]$/g, '').toUpperCase() : null, quote }, provider: reply.provider };
}

export function relevanceReason(verdict) {
  if (!verdict) return 'not judged';
  if (!['A', 'B'].includes(verdict.about)) return `off-subject: ${ABOUT[verdict.about]}`;
  if (!['A', 'B'].includes(verdict.market)) return `off-market: ${MARKET[verdict.market]}`;
  if (!verdict.span) return 'no sentence on the page shows it';
  return '';
}

export async function screenSources(ctx, { sources, purpose, subject, markets = [], regions = [] }) {
  const kept = [];
  const dropped = [];
  for (const [index, source] of (sources ?? []).entries()) {
    if (index >= MAX_SOURCES) {
      dropped.push({ url: source.url, reason: `not screened: over the limit of ${MAX_SOURCES} sources` });
      continue;
    }
    const judged = await judgeSource(ctx, { source, purpose, subject, markets, regions });
    const reason = judged.verdict ? relevanceReason(judged.verdict) : judged.reason;
    if (reason) dropped.push({ url: source.url, reason });
    else kept.push({ ...source, host: hostOf(source.url), about: judged.verdict.about, market: judged.verdict.market, span: judged.verdict.span, spanQuote: judged.verdict.quote, judgedBy: judged.provider ?? null });
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

export async function runScoping(ctx, { question, purpose = '', kind, regions = [], markets = [], languages = ['English'], rows = [], titles = [] }) {
  const levels = await subjectLevels(ctx, { question, kind, titles });
  const subjects = subjectLabels(rows, levels, kind);
  const views = await perspectives(ctx, { question, purpose, languages });
  const queries = composeQueries(subjects, views);
  const found = queries.length && ctx.search ? await ctx.search.search(queries.map((entry) => entry.query), { maxSources: MAX_SOURCES }).catch(() => []) : [];
  const screened = await screenSources(ctx, { sources: found, purpose: purpose || question, subject: screeningSubject(subjects, kind), markets, regions });
  const noted = await scopeNotes(ctx, { sources: screened.kept, purpose: purpose || question });
  const embedNote = ctx.embedder?.failureNote?.() ?? '';
  if (embedNote) ctx.log?.(embedNote);
  const scoping = {
    levels,
    languages,
    subjects,
    perspectives: views,
    queries,
    sources: screened.kept.map((source) => ({ url: source.url, title: source.title ?? '', host: source.host, about: source.about, market: source.market, span: source.span, judgedBy: source.judgedBy })),
    dropped: screened.dropped,
    notes: noted.notes,
    rejectedNotes: noted.rejected,
    enough: screened.kept.length >= MIN_KEPT_SOURCES,
    embedModel: ctx.embedder?.lastModel ?? null,
    at: new Date().toISOString(),
  };
  return { scoping, pages: screened.kept };
}
