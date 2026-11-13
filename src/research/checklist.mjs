import { plain } from './itemgate.mjs';
import { quoteFound } from './strategy.mjs';

const CONTENT_WORDS = (text) => new Set(plain(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
const JACCARD = (a, b) => {
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter((w) => b.has(w)).length / union : 0;
};

export const CHECKLIST_VERSION = 1;

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
  const wa = CONTENT_WORDS(a);
  const wb = CONTENT_WORDS(b);
  return JACCARD(wa, wb) >= 0.3;
}

export function judgeItem(item, pageText, checklist) {
  const checks = [];
  const text = String(pageText ?? '');
  for (const cluster of checklist) {
    for (const ci of cluster.items) {
      const question = ci.question;
      const answer = judgeYesNo(question, text, ci.numeric, item);
      if (answer.answer !== 'unknown' && !quoteFound(text, answer.quote)) {
        answer.answer = 'unknown';
        answer.quote = '';
      }
      checks.push({ id: cluster.clause + '|' + ci.question, ...answer });
    }
  }
  return checks;
}

function judgeYesNo(question, pageText, numeric, item) {
  const lower = pageText.toLowerCase();
  const q = question.toLowerCase();

  if (numeric?.measure && numeric.op && numeric.value !== null) {
    const m = MEASURES[numeric.measure];
    if (m) {
      const val = m.read(item, {});
      if (val !== undefined && compare(val, numeric.op, numeric.value)) {
        return { answer: 'yes', quote: String(val) };
      }
      if (val !== undefined) {
        return { answer: 'no', quote: String(val) };
      }
      return { answer: 'unknown', quote: '' };
    }
  }

  const qWords = new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  let score = 0;
  let matchedKeyWords = 0;
  for (const w of qWords) {
    if (lower.includes(w)) {
      score++;
      matchedKeyWords++;
    }
  }

  const negationWords = ['not', 'no', 'without', 'lack', 'missing', 'unavailable', 'cannot', 'unable', 'never'];
  for (const w of negationWords) {
    if (q.includes(w) && lower.includes(w)) score -= 2;
  }

  const hasNumber = /\d/.test(q) && /\d/.test(lower);
  if (hasNumber && score > 0) return { answer: 'yes', quote: '' };
  if (hasNumber && score < 0) return { answer: 'no', quote: '' };

  if (matchedKeyWords >= 2) return { answer: 'yes', quote: '' };
  if (matchedKeyWords === 0 && qWords.size > 0) return { answer: 'no', quote: '' };

  return { answer: 'unknown', quote: '' };
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
    const hardChecks = checks.filter((c) => c.id.includes('|'));
    const hardPass = hardChecks.length > 0 && hardChecks.every((c) => c.answer === 'yes');
    const unknown = checks.filter((c) => c.answer === 'unknown').length;
    const softYes = checks.filter((c) => c.answer === 'yes').length;
    return { hardPass, unknown, softYes };
  });
}

function checklistPrompt({ question, guidance = '' }) {
  const sys = 'You turn a research question into a checklist of yes/no questions, one per clause of the question. Each clause can produce multiple items. Answer with JSON only: {"items": [{"clause": "the exact words of the clause from the question", "question": "Does this ...?", "hard": true/false, "numeric": {"measure": "priceEur|coastKm|...", "op": "<=|>=|<|>", "value": 123, "unit": "EUR|km|..."} | null}]}.\n\n- "clause" is a clause from the user\'s question (split by commas, semicolons, "but also", "and also", "so").\n- "question" is a yes/no question that a human could answer by reading a supplier/listing page. Word it as "Does this <kind> ...?" or "Does the page state ...?".\n- "hard" = true when the user stated it as a requirement (must have, required, up to, at least, within). Soft = preference (highest, best, prefer, ratio).\n- "numeric" is present only when the question asks for a measurable quantity that code can verify (price, distance, months, area, etc.). Use only these measures: priceEur, coastKm, beachKm, lakeKm, workableMonths, comfortableMonths, optimalDays, hotDays, hottestC, coldestC, explorePoints, staysNearby, areaM2. When the question gives no number, set value to null. Never invent a number.\n- Each clause must yield at least one item. If a clause has no numeric measure, numeric is null and the question is qualitative.\n- The guidance field may add constraints; treat them as additional clauses.';
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
