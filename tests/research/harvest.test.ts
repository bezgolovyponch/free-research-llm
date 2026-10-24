import { describe, expect, it } from 'vitest';
import { HARVEST_PER_PIECE, harvestItems } from '../../src/research/harvest.mjs';

const kind = { label: 'plot of land', terms: ['terreno', 'land'] };
const options = { valueRange: [0, 20000], unit: 'EUR', kind };

describe('harvestItems', () => {
  it('takes single land listings from links on pages already read, with the price from the link text, priced ones first', () => {
    const node = {
      finding: { items: [{ url: 'https://www.portal.example/anuncio/terreno-faro-ID1aaaaa' }] },
      sources: [
        { id: 'S1', url: 'https://portal.example/resultados', links: [
          { url: 'https://portal.example/anuncio/terreno-faro-ID1aaaaa', text: 'Terreno Faro' },
          { url: 'https://portal.example/anuncio/terreno-silves-ID1bbbbb', text: 'Terreno Silves' },
          { url: 'https://portal.example/anuncio/terreno-coimbra-ID1ccccc', text: 'Terreno Urbano | Coimbra | 18.500 €' },
          { url: 'https://portal.example/anuncio/terreno-loule-ID1ddddd', text: 'Terreno Loulé | 360 000 €' },
          { url: 'https://portal.example/anuncio/arrendo-terreno-ID1eeeee', text: 'Arrendo terreno' },
          { url: 'https://portal.example/anuncio/apartamento-ID1fffff', text: 'Apartamento T2' },
          { url: 'https://s3.portal.example/p/terreno/6ad6708821e4.jpg', text: '![Image 5: terreno]' },
          { url: 'https://portal.example/resultados/comprar/terreno/todo-o-pais', text: 'Terrenos' },
          { url: 'mailto:x@portal.example', text: 'Contact' },
        ] },
        { id: 'S2', url: '', links: [{ url: 'https://portal.example/anuncio/terreno-x-ID1ggggg', text: 'Terreno' }] },
      ],
    };
    expect(harvestItems(node, options)).toEqual([
      { title: 'Terreno Urbano | Coimbra | 18.500 €', url: 'https://portal.example/anuncio/terreno-coimbra-ID1ccccc', value: 18500, unit: 'EUR', sourceId: 'S1', harvested: true },
      { title: 'Terreno Silves', url: 'https://portal.example/anuncio/terreno-silves-ID1bbbbb', value: null, unit: '', sourceId: 'S1', harvested: true },
    ]);
  });

  it('keeps at most 25 per piece', () => {
    const links = Array.from({ length: 40 }, (_, i) => ({ url: `https://portal.example/anuncio/terreno-${i}-ID1x${String(i).padStart(4, '0')}`, text: 'Terreno' }));
    expect(harvestItems({ sources: [{ id: 'S1', url: 'https://portal.example/r', links }] }, options)).toHaveLength(HARVEST_PER_PIECE);
  });
});
