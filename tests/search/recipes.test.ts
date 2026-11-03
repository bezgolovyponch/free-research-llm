import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MISSES, RECHECK_MS, SiteRecipes } from '../../src/search/recipes.mjs';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('SiteRecipes', () => {
  it('learns a recipe per site, asks for a page-2 check, then trusts it for a week', async () => {
    let now = 0;
    const recipes = new SiteRecipes({ now: () => now });
    const url = 'https://www.portal.example/land?x=1';
    expect(recipes.needsCheck(url)).toBe(false);
    recipes.learn(url, { template: 'portal.example/listing/*', methods: ['cards'], count: 20, country: 'PT', sample: ['Terreno A'] });
    expect(recipes.needsCheck(url)).toBe(true);
    expect(recipes.verify(url, { count: 18, template: 'portal.example/listing/*' })).toBe(true);
    expect(recipes.needsCheck(url)).toBe(false);
    now = RECHECK_MS + 1;
    expect(recipes.needsCheck(url)).toBe(true);
    expect(recipes.verifiedSearchPages()).toEqual([{ host: 'portal.example', url, count: 20, country: 'PT', sample: ['Terreno A'] }]);
  });

  it('re-learns when the listing links change shape and forgets a site after repeated misses', () => {
    const recipes = new SiteRecipes();
    const url = 'https://portal.example/land';
    recipes.learn(url, { template: 'portal.example/listing/*', methods: ['cards'], count: 20 });
    recipes.verify(url, { count: 20, template: 'portal.example/listing/*' });
    recipes.learn(url, { template: 'portal.example/ad/*', methods: ['json-ld'], count: 12 });
    expect(recipes.get(url)).toMatchObject({ template: 'portal.example/ad/*', verifiedAt: null });
    expect(recipes.verify(url, { count: 0, template: 'portal.example/ad/*' })).toBe(false);
    for (let i = 1; i < MAX_MISSES; i++) recipes.miss(url);
    expect(recipes.get(url)).toBeNull();
  });

  it('persists to its file and loads it back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-recipes-'));
    dirs.push(dir);
    const file = path.join(dir, 'recipes.json');
    const first = new SiteRecipes({ file });
    await first.load();
    first.learn('https://portal.example/land', { template: 't', methods: ['cards'], count: 5 });
    await first.writing;
    const second = await new SiteRecipes({ file }).load();
    expect(second.describe()).toEqual([{ host: 'portal.example', template: 't', methods: ['cards'], count: 5, country: '', verified: false, misses: 0 }]);
  });
});

describe('learned schemas in the site recipe', () => {
  it('keeps a schema when the recipe is relearned, drops it when it breaks, and remembers a failed attempt for a week', async () => {
    const { SiteRecipes } = await import('../../src/search/recipes.mjs');
    let now = Date.parse('2026-11-03T12:00:00Z');
    const recipes = new SiteRecipes({ now: () => now });
    const schema = { baseSelector: 'div.inzeraty', fields: [{ name: 'url', selector: 'a', type: 'attribute', attribute: 'href' }, { name: 'title', selector: 'a', type: 'text' }] };
    recipes.saveSchema('https://auto.bazos.cz/skoda/', schema);
    recipes.learn('https://auto.bazos.cz/skoda/40/', { template: 'auto.bazos.cz/inzerat/*', methods: ['schema'], count: 20 });
    expect(recipes.schemaFor('https://auto.bazos.cz/kia/')).toEqual(schema);
    recipes.dropSchema('https://auto.bazos.cz/kia/');
    expect(recipes.schemaFor('https://auto.bazos.cz/kia/')).toBeNull();
    expect(recipes.schemaFailedRecently('https://auto.bazos.cz/')).toBe(true);
    now += 8 * 24 * 3600 * 1000;
    expect(recipes.schemaFailedRecently('https://auto.bazos.cz/')).toBe(false);
  });
});
