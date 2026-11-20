import { quoteOnPage } from '../search/pagequote.mjs';
import { deriveRequirementIds } from './engine.mjs';

function askerText({ question = '', expected = '', constraints = {} } = {}) {
  const parts = [String(question ?? ''), String(expected ?? '')];
  for (const value of Object.values(constraints ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') parts.push(JSON.stringify(value));
    else parts.push(String(value));
  }
  return parts.filter(Boolean).join('\n');
}

function grounded(text, source) {
  const candidate = String(text ?? '').trim();
  if (!candidate) return { source: 'derived', quote: '' };
  if (quoteOnPage(source.toLowerCase(), candidate.toLowerCase())) return { source: 'quoted', quote: candidate };
  return { source: 'derived', quote: '' };
}

export function buildRequestModel({ question = '', expected = '', constraints = {}, decisionModel = null } = {}) {
  const source = askerText({ question, expected, constraints });
  const purposeText = String(decisionModel?.purpose ?? '').trim();
  const purposeGround = grounded(purposeText, source);
  const ids = deriveRequirementIds(decisionModel);
  const fallback = [expected && { id: 'E1', label: String(expected) }, { id: 'Q1', label: String(question ?? '') }].filter((r) => r && r.label.trim());
  const rows = ids.length ? ids : fallback;
  const requirements = rows.map((r) => {
    const supplied = decisionModel?.requirements?.find?.((m) => (m.measure ?? '') === r.id)?.quote ?? '';
    const bySupplied = supplied ? grounded(supplied, source) : null;
    const byClause = grounded(r.label, source);
    const ground = bySupplied?.source === 'quoted' ? bySupplied : byClause;
    return { id: r.id, clause: r.label, source: ground.source, quote: ground.quote };
  });
  return {
    purpose: { text: purposeText, source: purposeGround.source, quote: purposeGround.quote },
    requirements,
  };
}

export function servesless(nodes, requirements) {
  const ids = new Set((requirements ?? []).map((r) => r.id));
  const empty = [];
  for (const node of nodes ?? []) {
    const serves = Array.isArray(node.serves) ? node.serves.filter((id) => ids.has(id)) : [];
    if (!serves.length) empty.push(node.id);
  }
  return empty;
}

export function requestModelSummary(model) {
  const quoted = model.requirements.filter((r) => r.source === 'quoted').length;
  const derived = model.requirements.length - quoted;
  return `request model: ${model.requirements.length} requirement(s) — ${quoted} quoted, ${derived} derived; purpose ${model.purpose.source}`;
}
