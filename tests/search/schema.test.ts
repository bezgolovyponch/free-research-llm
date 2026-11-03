import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySchema, schemaPrompt, schemaSample, validSchema, verifySchema } from '../../src/search/schema.mjs';

const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'bazos-skoda-cards.html'), 'utf8');
const base = 'https://auto.bazos.cz/skoda/';
const bazos = {
  baseSelector: 'div.inzeraty',
  fields: [
    { name: 'url', selector: 'h2.nadpis a', type: 'attribute', attribute: 'href' },
    { name: 'title', selector: 'h2.nadpis a', type: 'text' },
    { name: 'price', selector: 'div.inzeratycena', type: 'text' },
    { name: 'place', selector: 'div.inzeratylok', type: 'text' },
    { name: 'description', selector: 'div.popis', type: 'text' },
  ],
};

describe('learned site schema on a real bazos page', () => {
  it('reads every card with its link, price, place and facts', () => {
    const items = applySchema(html, base, bazos);
    expect(items).toHaveLength(6);
    expect(items[0]).toMatchObject({ url: 'https://auto.bazos.cz/inzerat/225951282/skoda-roomster-14-16v-63-kw-puvod-nl-bez-koroze.php', value: 65000, unit: 'CZK', place: 'Vsetín 756 23', via: ['schema'] });
    expect(items[0].title).toContain('Škoda Roomster 1.4 16V 63 kW');
    expect(items[0].attrs.description).toContain('v provozu od 8/2008');
  });

  it('accepts a schema that adds places the generic reader missed, and rejects one that finds too little', () => {
    const items = applySchema(html, base, bazos);
    const generic = items.map(({ place, attrs, ...rest }) => ({ ...rest, place: '' }));
    expect(verifySchema(items, generic)).toMatchObject({ ok: true, placed: 6 });
    expect(verifySchema(items.slice(0, 1), generic)).toMatchObject({ ok: false });
    expect(verifySchema(items, items)).toMatchObject({ ok: true });
    const bare = items.map(({ attrs, ...rest }) => rest);
    expect(verifySchema(bare, bare)).toMatchObject({ ok: false, reason: 'adds nothing the generic reader did not already find' });
  });

  it('refuses a schema without url and title, or with a broken selector', () => {
    expect(validSchema({ baseSelector: 'div', fields: [{ name: 'price', selector: 'b' }] })).toBe(false);
    expect(applySchema(html, base, { ...bazos, baseSelector: 'div[[' })).toEqual([]);
  });

  it('samples the page from the first listing link without scripts, and asks for CSS selectors', () => {
    const page = `<html><head><script>var x = 1;</script></head><body><nav>menu</nav>${html}</body></html>`;
    const sample = schemaSample(page, base);
    expect(sample).not.toContain('var x = 1');
    expect(sample).toContain('inzerat/225951282');
    const prompt = JSON.stringify(schemaPrompt({ host: 'auto.bazos.cz', kind: 'used car', sample }));
    expect(prompt).toContain('baseSelector');
    expect(prompt).toContain('auto.bazos.cz');
  });
});

describe('page reading with a stored schema', () => {
  it('uses the site schema first and drops it when it stops finding listings', async () => {
    const { SearchService } = await import('../../src/search/search.mjs');
    const dropped: string[] = [];
    const recipes = { get: () => null, schemaFor: () => bazos, dropSchema: (url: string) => dropped.push(url) };
    const search = new SearchService({ backends: [], recipes } as never);
    const page = search.parsePage(html, { html: true, base, status: 200 });
    expect(page.methods).toEqual(['schema']);
    expect(page.listings[0].place).toBe('Vsetín 756 23');
    search.parsePage('<html><body>no listings</body></html>', { html: true, base, status: 200 });
    expect(dropped).toEqual([base]);
  });
});

describe('schema check against the priced generic listings', () => {
  it('accepts a schema that finds every priced card when the generic reader also counted unpriced promoted links', () => {
    const items = applySchema(html, base, bazos);
    const generic = [...items.map(({ place, attrs, ...rest }) => ({ ...rest, place: '' })), ...items.map((i) => ({ title: i.title, url: `${i.url}?top`, value: null, unit: '', place: '' }))];
    expect(verifySchema(items, generic)).toMatchObject({ ok: true });
  });
});
