import { plain } from './itemgate.mjs';
import { quoteFound } from './quote.mjs';

export function replyList(data) {
  if (Array.isArray(data)) return data;
  return Object.values(data ?? {}).find(Array.isArray) ?? [];
}

export function applyQuoteCheck(replies, pageText) {
  return replies.map((r) => {
    if (!r || typeof r !== 'object') return { ...r, answer: 'unknown', quote: '' };
    if (r.answer !== 'unknown' && r.quote && !quoteFound(pageText, r.quote)) {
      return { ...r, answer: 'unknown', quote: '' };
    }
    return r;
  });
}

export const CHECKLIST_VERSION = 2;

export async function proposeChecklist({ router, question, guidance = '', samples = 3 }) {
  const messages = checklistPrompt({ question, guidance });
  const replies = await Promise.all(
    Array.from({ length: samples }, () =>
      router.complete({ purpose: 'checklist', tier: 'deep', temperature: 0.7, messages }).catch(() => null)
    )
  );
  return replies.filter((r) => r?.data?.items?.length).map((r) => normalizeSample(r.data));
}

export function normalizeSample(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, 12).map((i) => ({
    clause: String(i?.clause ?? '').slice(0, 200),
    question: String(i?.question ?? '').slice(0, 300),
    hard: Boolean(i?.hard),
    numeric: i?.numeric ? {
      measure: String(i.numeric.measure ?? ''),
      op: ['<=', '>=', '<', '>'].includes(i.numeric.op) ? i.numeric.op : '',
      value: i.numeric.value !== null && i.numeric.value !== undefined ? Number(i.numeric.value) : null,
      unit: String(i.numeric.unit ?? ''),
    } : undefined,
  })).filter((i) => i.clause && i.question);
  return { items };
}

export function clusterChecklist(samples) {
  const byClause = new Map();
  for (const sample of samples) {
    for (const item of sample.items) {
      const key = item.clause.toLowerCase().trim();
      if (!byClause.has(key)) byClause.set(key, []);
      byClause.get(key).push(item);
    }
  }

  const majority = Math.floor(samples.length / 2) + 1;
  const clusters = [];

  for (const [clause, items] of byClause) {
    const groups = [];
    for (const item of items) {
      let placed = false;
      for (const group of groups) {
        if (sameMeaning(group[0].question, item.question)) {
          group.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push([item]);
    }

    const best = groups
      .filter((g) => g.length >= majority)
      .sort((a, b) => b.length - a.length)[0];

    if (best) {
      clusters.push({ clause, items: best });
    } else if (items.length > 0) {
      clusters.push({ clause, items: [{ clause, question: 'Does this ' + clause + '?', hard: false }] });
    }
  }

  return clusters;
}

function sameMeaning(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  return jaccard(wa, wb) >= 0.3;
}

function contentWords(text) {
  return new Set(plain(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter((w) => b.has(w)).length / union : 0;
}

const OPS = ['<=', '>=', '<', '>'];

export function compare(value, op, limit) {
  if (op === '<=') return value <= limit;
  if (op === '>=') return value >= limit;
  if (op === '<') return value < limit;
  return value > limit;
}

export const MEASURES = {
  priceEur: { read: (row) => row.value !== null && row.value !== undefined ? Number(row.value) : undefined },
  distanceKm: { read: (row) => row.distanceKm },
  coastKm: { read: (row) => row.site?.coastKm },
  beachKm: { read: (row) => row.site?.beachKm },
  lakeKm: { read: (row) => row.site?.lakeKm },
  workableMonths: { read: (row) => row.site?.climate?.workable },
  comfortableMonths: { read: (row) => row.site?.climate?.comfortable },
  optimalDays: { read: (row) => row.site?.climate?.cci?.optimalDays },
  hotDays: { read: (row) => row.site?.climate?.cci?.hotDays },
  hottestC: { read: (row) => row.site?.climate?.hottest },
  coldestC: { read: (row) => row.site?.climate?.coldest },
  explorePoints: { read: (row) => row.site ? (row.site.beaches ?? 0) + (row.site.viewpoints ?? 0) + (row.site.attractions ?? 0) + (row.site.reserves ?? 0) + (row.site.protectedAreas ?? 0) + (row.site.hikingRoutes ?? 0) : undefined },
  staysNearby: { read: (row) => row.site ? (row.site.lodging ?? 0) + (row.site.campsites ?? 0) : undefined },
  areaM2: { read: (row) => row.area ?? row.size },
};

export function checklistSummary(items) {
  return items.map((item) => {
    const checks = item.checks ?? [];
    const hardChecks = checks.filter((c) => c.hard === true);
    const hardPass = hardChecks.length > 0 && hardChecks.every((c) => c.answer === 'yes');
    const unknown = checks.filter((c) => c.answer === 'unknown').length;
    const softYes = checks.filter((c) => c.hard !== true && c.answer === 'yes').length;
    return { hardPass, unknown, softYes };
  });
}

export function checklistFingerprint(checklist) {
  const parts = [];
  for (const cluster of checklist) {
    for (const ci of cluster.items) {
      parts.push(`${cluster.clause}|${ci.question}|${ci.hard ? 1 : 0}|${ci.numeric ? `${ci.numeric.measure}:${ci.numeric.op}:${ci.numeric.value}:${ci.numeric.unit}` : 'none'}`);
    }
  }
  return parts.sort().join('::');
}

function checklistPrompt({ question, guidance = '' }) {
  const sys = 'You turn a research question into a checklist of yes/no questions about ONE delivered item. Each clause of the question produces items that test that single item. Answer with JSON only: {"items": [{"clause": "short phrase from the question naming the property", "question": "Does this <kind> ...?", "hard": true/false, "numeric": {"measure": "distanceKm|areaM2|coastKm|...", "op": "<=|>=|<|>", "value": 123, "unit": "km|m2|..."} | null}]}.\n\n- "clause" is a short phrase naming the property tested (e.g. "<property> is <value>", "within <distance> of <place>"), NOT the whole sentence.\n- "question" is a yes/no question about ONE item: "Does this <kind> ...?".\n- "hard" = true when the user stated it as a requirement (must have, required, up to, at least, within). Soft = preference (highest, best, prefer, ratio).\n- "numeric" is present only when the question asks for a measurable quantity that code can verify. Use only these measures: distanceKm (distance from the asked place), priceEur, coastKm, beachKm, lakeKm, workableMonths, comfortableMonths, optimalDays, hotDays, hottestC, coldestC, explorePoints, staysNearby, areaM2. When the question gives no number, set value to null. Never invent a number.\n- DROP price limits (checked by the acceptance value range in any currency) and collection/count clauses ("at least N items", "up to M as trade-off", "list of X") — they are checked at acceptance level, not per item.\n- Each clause must yield at least one item. If a clause has no numeric measure, numeric is null and the question is qualitative.\n- The guidance field may add constraints; treat them as additional clauses.';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: 'Question: ' + question + (guidance ? '\nGuidance: ' + guidance : '') }
  ];
}

export class ChecklistModeler {
  constructor({ router, samples = 3 } = {}) {
    this.router = router;
    this.samples = samples;
  }

  async build(question, guidance = '') {
    const samples = await proposeChecklist({ router: this.router, question, guidance, samples: this.samples });
    if (samples.length < 2) return null;
    return clusterChecklist(samples);
  }
}

export function kindCluster(kind) {
  const not = (kind.not ?? []).length ? ` and not ${kind.not.join(', ')}` : '';
  return { clause: 'kind', items: [{ question: `Is this page one ${kind.label} offered as asked (not a part, accessory, wanted ad or list${not})?`, hard: true, numeric: null }] };
}

export class ChecklistJudge {
  constructor({ router } = {}) {
    this.router = router;
  }

  async judge(item, pageText, checklist, kind = null) {
    const checks = [];
    const asked = kind?.label ? [...checklist, kindCluster(kind)] : checklist;
    const numericItems = [];
    const qualitativeItems = [];

    for (const cluster of asked) {
      for (const ci of cluster.items) {
        if (ci.numeric?.measure && ci.numeric.op && ci.numeric.value !== null && MEASURES[ci.numeric.measure]) {
          numericItems.push({ cluster, item: ci });
        } else {
          qualitativeItems.push({ cluster, item: ci });
        }
      }
    }

    for (const { cluster, item: ci } of numericItems) {
      const m = MEASURES[ci.numeric.measure];
      const val = m.read(item, {});
      let answer = 'unknown';
      let quote = '';
      if (val !== undefined) {
        if (compare(val, ci.numeric.op, ci.numeric.value)) {
          answer = 'yes';
        } else {
          answer = 'no';
        }
        quote = `${ci.numeric.measure}: ${val} ${ci.numeric.unit}`;
      }
      const id = cluster.clause + '|' + ci.question;
      checks.push({ id, answer, quote, hard: ci.hard, clause: cluster.clause });
    }

    if (qualitativeItems.length > 0 && this.router) {
      const pageTextCut = String(pageText ?? '').slice(0, 6000);
      const questions = qualitativeItems.map(({ cluster, item: ci }) => ({
        id: cluster.clause + '|' + ci.question,
        question: ci.question,
        hard: ci.hard,
        clause: cluster.clause,
      }));

      const prompt = judgePrompt({ questions, pageText: pageTextCut });
      let reply = null;
      try {
        reply = await this.router.complete({
          purpose: 'checklist',
          tier: 'fast',
          temperature: 0,
          messages: prompt,
        });
      } catch {
        reply = null;
      }

      const replies = replyList(reply?.data);
      const validated = applyQuoteCheck(replies, pageTextCut);

      for (const q of questions) {
        const reply = validated.find((r) => r.id === q.id);
        if (reply) {
          const answer = ['yes', 'no', 'unknown'].includes(reply.answer) ? reply.answer : 'unknown';
          checks.push({ id: q.id, answer, quote: reply.quote ?? '', hard: q.hard, clause: q.clause });
        } else {
          checks.push({ id: q.id, answer: 'unknown', quote: '', hard: q.hard, clause: q.clause });
        }
      }
    }

    for (const { cluster, item: ci } of qualitativeItems) {
      if (!this.router) {
        const id = cluster.clause + '|' + ci.question;
        checks.push({ id, answer: 'unknown', quote: '', hard: ci.hard, clause: cluster.clause });
      }
    }

    return checks;
  }
}

function judgePrompt({ questions, pageText }) {
  const sys = 'You are a strict judge. For each question, answer whether the page text supports "yes", "no", or "unknown". Provide a short quote from the page text that directly supports your answer, or empty string if unknown. Answer with JSON only: [{"id": "...", "answer": "yes|no|unknown", "quote": "exact text from page"}]';
  const qText = questions.map((q) => `${q.id}: ${q.question}`).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Item page text:\n${pageText}\n\nQuestions:\n${qText}` },
  ];
}
