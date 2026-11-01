import { describe, expect, it } from 'vitest';
import { plain, screenItem, screenItems } from '../../src/research/itemgate.mjs';

const kind = { label: 'plot of land', terms: ['land', 'terreno', 'arsa', 'parcela'] };
const options = { valueRange: [0, 20000], unit: 'EUR', kind, convert: (v: number, from: string) => (from === 'USD' ? v * 0.9 : v) };

describe('item gate', () => {
  it('keeps single land listings in range and says why it rejects the rest', () => {
    expect(screenItem({ url: 'https://www.imovirtual.com/pt/anuncio/terreno-rustico-ID1iZBr', title: 'Terreno rústico', value: 18000, unit: 'EUR' }, options)).toMatchObject({ ok: true, priced: true });
    expect(screenItem({ url: 'https://www.olx.pt/d/anuncio/cede-se-jazigo-IDJEXGe.html', title: 'Cede-se Jazigo', value: 15000, unit: 'EUR' }, options).reasons).toEqual(['not a plot of land']);
    expect(screenItem({ url: 'https://www.sahibinden.com/satilik-arsa', title: 'satilik arsa', value: null, unit: '' }, options).reasons).toEqual(['not a single listing page']);
    expect(screenItem({ url: 'https://x.example/land/123456789', title: 'Land for development', value: 90000, unit: 'USD' }, options).reasons).toEqual(['price 90000 USD is outside 0–20000 EUR']);
    expect(screenItem({ url: 'https://x.example/land/123456789', title: 'Land', value: 21000, unit: 'USD' }, options).ok).toBe(true);
    expect(screenItem({ url: 'https://x.example/land/123456789', title: 'Kyero Northern Portugal Land Search', value: 12600, unit: 'EUR' }, options).reasons).toEqual(['not a single listing page']);
  });

  it('keeps a land listing with no price as "to check" and caps the rejected list', () => {
    const { kept, rejected } = screenItems([{ url: 'https://properties.lefigaro.com/announces/land-andalusia/109197729/', title: 'Seaside land Marbella', value: null, unit: '' }, ...Array.from({ length: 30 }, (_, i) => ({ url: `https://x.example/search?page=${i}`, title: 'search', value: null, unit: '' }))], options);
    expect(kept).toEqual([expect.objectContaining({ toCheck: 'price not given; read from the page' })]);
    expect(rejected).toHaveLength(20);
    expect(plain('Terreno Rústico Ğ')).toBe('terreno rustico g');
  });
});

describe('item gate: rentals, word ends, broken links', () => {
  it('refuses plots offered for rent', () => {
    for (const title of ['Arrendo terreno para estaleiro', 'Terreno para arrendamento', 'Vendo ou alugo terreno com boxes', 'Land for rent near Faro', 'Terreno en alquiler']) {
      expect(screenItem({ title, url: 'https://portal.example/anuncio/x-ID1abcde' }, options).reasons, title).toContain('offered for rent, not for sale');
    }
    expect(screenItem({ title: 'Terreno rústico em Silves', url: 'https://portal.example/anuncio/x-ID1abcde' }, options).ok).toBe(true);
    expect(screenItem({ title: 'Land', url: 'https://goswap.org/listing/trade-75k-costa-rica-land-for-40-cruising-sailboat-monohull-14136' }, options).reasons).toContain('offered as a swap, not for sale');
  });

  it('refuses Czech and Polish rentals and wanted ads, which are not plots for sale', () => {
    const cz = { ...options, kind: { label: 'plot of land', terms: ['pozemek', 'pozemku', 'dzialka'] } };
    expect(screenItem({ title: 'Pronájem: Hala, pozemek, Týniště n. Orl.', url: 'https://reality.bazos.cz/inzerat/225716435/pronajem-hala-pozemek.php' }, cz).reasons).toContain('offered for rent, not for sale');
    expect(screenItem({ title: 'Działka na wynajem', url: 'https://www.otodom.pl/pl/oferta/dzialka-ID4abcd' }, cz).reasons).toContain('offered for rent, not for sale');
    expect(screenItem({ title: 'Koupím pozemek na chatu, Českolipsko', url: 'https://inzerce2.cz/inzerat-111217/koupim-koupim-pozemek-na-chatu-ceskolipsko' }, cz).reasons).toContain('a wanted ad, not an offer');
    expect(screenItem({ title: 'Prodej pozemku s nájemcem 800 m²', url: 'https://www.sreality.cz/detail/prodej/pozemek/zahrada/obora-obora-/2274426956' }, cz).ok).toBe(true);
  });

  it('matches a land word only as a whole word, plural allowed', () => {
    const vn = { label: 'plot of land', terms: ['dat', 'land', 'terreno'] };
    expect(screenItem({ title: 'Delhi in July', url: 'https://en.climate-data.org/asia/india/delhi/delhi-967662/' }, { kind: vn }).reasons).toContain('not a plot of land');
    expect(screenItem({ title: 'Ban dat Nha Trang', url: 'https://nhatot.example/mua-ban-dat-nha-trang/135401558.htm' }, { kind: vn }).ok).toBe(true);
    expect(screenItem({ title: 'Terrenos em Faro', url: 'https://portal.example/anuncio/x-ID1abcde' }, { kind: vn }).ok).toBe(true);
  });

  it('refuses an item of another kind that shares a word with the asked kind', async () => {
    const { isKind } = await import('../../src/research/itemgate.mjs');
    const { templateById } = await import('../../src/research/templates.mjs');
    const plots = templateById('glamping-location').itemKind;
    expect(isKind({ title: 'Ver foto 2016 Land Rover Range Rover Evoque 16.950', url: 'https://rd.example/cars/1' }, plots)).toBe(false);
    expect(isKind({ title: 'Terreno rústico com acesso de carro', url: 'https://imo.example/terreno-1' }, plots)).toBe(true);
    expect(isKind({ title: 'Cemitério da Guia em Cascais- Terreno perpétuo', url: 'https://imo.example/cemiterio-da-guia-terreno-perpetuo' }, plots)).toBe(false);
    expect(isKind({ title: 'Land Rover', url: 'https://x.example/1' }, { label: 'x', terms: ['land'] })).toBe(true);
  });

  it('does not throw on a link with a broken percent escape', () => {
    expect(() => screenItem({ title: 'Terreno', url: 'https://portal.example/anuncio/terreno-%E0%A4%A-ID1abcde' }, options)).not.toThrow();
  });
});

describe('item gate: Czech/Slovak/Polish land terms', () => {
  const glampingKind = { label: 'plot of land', terms: ['land', 'terreno', 'arsa', 'parcela', 'pozemek', 'pozemku', 'pozemky', 'pozemkem', 'parcely', 'parcelu', 'zahrada', 'zahrady', 'louka', 'louky', 'pozemok', 'dzialka', 'dzialki', 'dzialke'] };
  const glampingOptions = { valueRange: [0, 20000], unit: 'EUR', kind: glampingKind, convert: (v: number, from: string) => (from === 'USD' ? v * 0.9 : v) };

  it('accepts Czech/Slovak/Polish land listings by title and URL', () => {
    expect(screenItem({ title: 'Prodej zahrady 464 m², Obora', url: 'https://www.bezrealitky.cz/nemovitosti-byty-domy/1063228-nabidka-prodej-pozemku-velka-nad-velickou' }, glampingOptions).ok).toBe(true);
    expect(screenItem({ title: 'Prodej pozemku 1000 m²', url: 'https://www.sreality.cz/detail/prodej/pozemek/bydleni/zulova-zulova-/1524400204' }, glampingOptions).ok).toBe(true);
    expect(screenItem({ title: 'Prodej parcely 500 m²', url: 'https://www.bezrealitky.cz/nemovitosti-byty-domy/prodej-parcelu-12345' }, glampingOptions).ok).toBe(true);
    expect(screenItem({ title: 'Prodej louky 2000 m²', url: 'https://www.sreality.cz/detail/prodej/pozemek/louka/kunice-kunice-/2274426957' }, glampingOptions).ok).toBe(true);
    expect(screenItem({ title: 'Sprzedaż działki 1000 m²', url: 'https://otodom.pl/oferta/dzialka-12345' }, glampingOptions).ok).toBe(true);
  });

  it('rejects apartment listings even with similar URL patterns', () => {
    expect(screenItem({ title: 'Prodej bytu 3+1 68 m²', url: 'https://www.sreality.cz/detail/prodej/byt/3+1/brno-trnita-koliskova/3380817996' }, glampingOptions).ok).toBe(false);
    expect(screenItem({ title: 'Prodej bytu 2+kk', url: 'https://www.bezrealitky.cz/nemovitosti-byty-domy/prodej-byty-12345' }, glampingOptions).ok).toBe(false);
  });
});
