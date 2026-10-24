export const STORED_TEXT_CHARS = 4000;
export const STORED_LINKS = 40;
export const CLIENT_TEXT_CHARS = 300;

export function compactSources(sources = [], { text = STORED_TEXT_CHARS, links = STORED_LINKS } = {}) {
  let trimmed = 0;
  const out = sources.map((s) => {
    const longText = typeof s.text === 'string' && s.text.length > text;
    const manyLinks = Array.isArray(s.links) && s.links.length > links;
    if (!longText && !manyLinks) return s;
    trimmed += 1;
    return { ...s, ...(longText ? { text: s.text.slice(0, text) } : {}), ...(manyLinks ? { links: s.links.slice(0, links) } : {}) };
  });
  return { sources: out, trimmed };
}

export function compactProject(project) {
  let trimmed = 0;
  for (const node of project.nodes ?? []) {
    if (!node.sources?.length) continue;
    const result = compactSources(node.sources);
    node.sources = result.sources;
    trimmed += result.trimmed;
  }
  return trimmed;
}

function clientSource(s) {
  const { links, text, ...rest } = s;
  return { ...rest, text: typeof text === 'string' ? text.slice(0, CLIENT_TEXT_CHARS) : text, linkCount: Array.isArray(links) ? links.length : 0 };
}

export function clientNodes(nodes = []) {
  return nodes.map((n) => (n.sources?.length ? { ...n, sources: n.sources.map(clientSource) } : n));
}
