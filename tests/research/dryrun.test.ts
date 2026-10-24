import { describe, expect, it } from 'vitest';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { previewMaintenance } from '../../src/research/dryrun.mjs';

describe('previewMaintenance', () => {
  it('shows what the start-of-loop repairs and gates would change, without touching the research', async () => {
    const engine = new ResearchEngine({ router: null, search: null, store: { cache: new Map(), save: async (p: unknown) => p } as never });
    const project = {
      question: 'Find plots for a glamping business near the sea, 20000EUR max',
      templateId: 'glamping-location',
      acceptance: { expected: '50 plots', itemCount: 50, valueRange: [0, 20000], unit: 'EUR', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: 'Q', title: 'D1', question: 'Which coastal land parcels in Portugal are listed for sale under 20,000 EUR?', status: 'verified', dependsOn: [], finding: { answer: 'some', items: [
          { url: 'https://www.imovirtual.com/pt/anuncio/terreno-rustico-ID1iZBr', title: 'Terreno rústico 4 448 m²', value: 18000, unit: 'EUR' },
          { url: 'https://www.olx.pt/d/anuncio/cede-se-jazigo-4-6-lugares-IDJEXGe.html', title: 'Cede-se Jazigo 4/6 lugares', value: 15000, unit: 'EUR' },
          { url: 'https://www.sahibinden.com/satilik-arsa', title: 'satilik arsa', value: null, unit: '' },
          { url: 'https://example.com/listing/plot-9934411', title: 'Plot of land near Antalya', value: 400000, unit: 'EUR' },
        ] } },
      ],
    };
    const frozen = JSON.stringify(project);
    const report = await previewMaintenance(engine, project);
    expect(JSON.stringify(project)).toBe(frozen);
    expect(report.changes.retitled).toEqual(['D1: "D1" → "Coastal land parcels in Portugal are listed for"']);
    expect(report.changes.removedItems).toHaveLength(3);
    expect(report.changes.removedItems.join('\n')).toMatch(/jazigo.*not a plot of land/);
    expect(report.changes.removedItems.join('\n')).toMatch(/satilik-arsa.*not a single listing page/);
    expect(report.changes.removedItems.join('\n')).toMatch(/9934411.*price 400000 EUR is outside 0–20000 EUR/);
    expect(report.itemsKept).toBe(1);
  });
});
