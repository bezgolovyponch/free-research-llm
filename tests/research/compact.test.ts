import { describe, expect, it } from 'vitest';
import { CLIENT_TEXT_CHARS, STORED_LINKS, STORED_TEXT_CHARS, clientNodes, compactProject, compactSources } from '../../src/research/compact.mjs';

const source = (n: number, links: number) => ({ id: 'S1', url: 'https://a.example', title: 't', text: 'x'.repeat(n), links: Array.from({ length: links }, (_, i) => ({ url: `https://a.example/${i}` })) });

describe('source compaction', () => {
  it('caps stored page text and links, and leaves small sources untouched', () => {
    const small = source(100, 3);
    const { sources, trimmed } = compactSources([small, source(20000, 500)]);
    expect(trimmed).toBe(1);
    expect(sources[0]).toBe(small);
    expect(sources[1].text).toHaveLength(STORED_TEXT_CHARS);
    expect(sources[1].links).toHaveLength(STORED_LINKS);
    const project = { nodes: [{ id: 'D1', sources: [source(9000, 100)] }, { id: 'D2' }] };
    expect(compactProject(project)).toBe(1);
    expect(compactProject(project)).toBe(0);
  });

  it('sends pages a light view: short text and a link count instead of the link list', () => {
    const [node] = clientNodes([{ id: 'D1', sources: [source(5000, 80)] }]);
    expect(node.sources[0].text).toHaveLength(CLIENT_TEXT_CHARS);
    expect(node.sources[0].linkCount).toBe(80);
    expect('links' in node.sources[0]).toBe(false);
    expect(clientNodes([{ id: 'D2' }])[0]).toEqual({ id: 'D2' });
  });
});
