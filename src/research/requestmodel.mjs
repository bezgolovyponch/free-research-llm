import { quoteOnPage } from '../search/pagequote.mjs';
import { deriveRequirementIds } from './engine.mjs';
import { countryByCode } from './brief.mjs';

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

function regionName(code) {
  const country = countryByCode(code);
  return country?.name ?? code;
}

export function buildRoles({ question = '', expected = '', constraints = {}, brief = null, domain = null } = {}) {
  const source = askerText({ question, expected, constraints });
  const roles = [];

  if (brief?.regions?.length) {
    const roleText = brief.located ? 'sources must be in it' : 'where the result is used';
    for (const code of brief.regions) {
      const name = regionName(code);
      const ground = grounded(name, source);
      roles.push({ name, type: 'place', role: roleText, source: ground.source, quote: ground.quote, from: 'brief' });
    }
  }

  if (domain?.actors?.length) {
    for (const actor of domain.actors) {
      let name, actorSource;
      if (typeof actor === 'string') {
        name = actor;
        actorSource = '';
      } else if (actor && typeof actor === 'object') {
        name = String(actor.text ?? '');
        actorSource = String(actor.source ?? '');
      } else {
        continue;
      }
      if (!name.trim()) continue;
      const ground = grounded(name, source);
      roles.push({ name, type: 'actor', role: '', source: ground.source, quote: ground.quote, from: 'domain', actorSource });
    }
  }

  return roles;
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

export function rolesSummary(roles) {
  const actors = roles.filter((r) => r.type === 'actor').length;
  const places = roles.filter((r) => r.type === 'place').length;
  const quoted = roles.filter((r) => r.source === 'quoted').length;
  return `roles: ${actors} actor(s), ${places} place(s) — ${quoted} quoted`;
}

export function captureAlternatives(requestModel, node, sources) {
  if (!requestModel?.requirements?.length) return 0;
  const ids = new Set(requestModel.requirements.map((r) => r.id));
  const serves = Array.isArray(node?.serves) ? node.serves.filter((id) => ids.has(id)) : [];
  if (!serves.length) return 0;
  requestModel.alternatives = requestModel.alternatives ?? [];
  const known = new Set(requestModel.alternatives.map((a) => `${a.requirementId}|${String(a.means).toLowerCase().replace(/\s+/g, ' ')}`));
  let added = 0;
  for (const source of sources ?? []) {
    const body = String(source?.text ?? '');
    for (const listing of source?.listings ?? []) {
      const means = String(listing?.title ?? '').replace(/\s+/g, ' ').trim();
      if (!means) continue;
      if (!quoteOnPage(body, means)) continue;
      for (const requirementId of serves) {
        const key = `${requirementId}|${means.toLowerCase()}`;
        if (known.has(key)) continue;
        known.add(key);
        requestModel.alternatives.push({ requirementId, means, quote: means, url: listing?.url ?? source?.url ?? '' });
        added++;
      }
    }
  }
  return added;
}
