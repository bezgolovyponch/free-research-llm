import { suggestPrompt } from './prompts.mjs';
import { METHODS, ROOT_ID } from './tree.mjs';
import { NotFoundError } from './engine.mjs';

const MAX_SUGGESTIONS = 6;

function normalized(textValue) {
  return String(textValue ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function gradeSuggestion(raw, sources) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const sourceIds = (Array.isArray(raw?.sourceIds) ? raw.sourceIds : []).map((x) => String(x).replace(/[[\]]/g, '')).filter((x) => byId.has(x));
  const quote = String(raw?.quote ?? '').trim().slice(0, 200);
  const quoteFound = quote.length >= 8 && sourceIds.some((x) => normalized(byId.get(x).text).includes(normalized(quote)));
  return {
    title: String(raw?.title || raw?.question || '').slice(0, 90),
    question: String(raw?.question ?? '').trim().slice(0, 400),
    why: String(raw?.why ?? '').slice(0, 300),
    method: METHODS.includes(raw?.method) ? raw.method : 'lookup',
    searchQueries: (Array.isArray(raw?.searchQueries) ? raw.searchQueries : []).map(String).filter(Boolean).slice(0, 3),
    sourceIds,
    quote,
    grounded: quoteFound ? 'quoted' : sourceIds.length ? 'cited' : 'ungrounded',
  };
}

export class SubIssueSuggester {
  constructor({ engine }) {
    this.engine = engine;
  }

  async suggest(id, nodeId) {
    const project = await this.engine.load(id);
    const node = nodeId === ROOT_ID ? null : project.nodes.find((n) => n.id === nodeId);
    if (nodeId !== ROOT_ID && !node) throw new NotFoundError(`node ${nodeId} not found`);
    const search = this.engine.search;
    const queries = node ? [...node.searchQueries, node.question] : [project.question];
    const found = search?.enabled ? await search.search(queries, { maxSources: 5 }) : [];
    const sources = found.map((s, i) => ({ ...s, id: `S${i + 1}` }));
    const reply = await this.engine.router.complete({ purpose: 'suggest', tier: 'deep', messages: suggestPrompt({ project, node, sources }) });
    const rank = { quoted: 0, cited: 1, ungrounded: 2 };
    const items = (Array.isArray(reply.data?.suggestions) ? reply.data.suggestions : [])
      .map((raw) => gradeSuggestion(raw, sources))
      .filter((s) => s.question)
      .sort((a, b) => rank[a.grounded] - rank[b.grounded])
      .slice(0, MAX_SUGGESTIONS);
    const result = { at: new Date().toISOString(), model: `${reply.provider}/${reply.model}`, sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.url })), items };
    const fresh = await this.engine.load(id);
    if (node) fresh.nodes.find((n) => n.id === nodeId).suggestions = result;
    else fresh.rootSuggestions = result;
    this.engine.emit(fresh, 'suggest', `${nodeId}: ${items.length} researched sub-issue suggestion(s), ${items.filter((s) => s.grounded !== 'ungrounded').length} grounded in sources`, { nodeId });
    await this.engine.store.save(fresh);
    return result;
  }
}
