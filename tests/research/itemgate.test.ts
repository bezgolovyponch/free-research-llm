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

  it('refuses a Czech car wanted ad that says "sháním" (I am looking for)', () => {
    const car = { ...options, kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'] } };
    expect(screenItem({ title: 'Toyota Yaris, sháním', url: 'https://auto.bazos.cz/inzerat/225000004/toyota-yaris-shanim.php', value: 20000, unit: 'CZK' }, car).reasons).toContain('a wanted ad, not an offer');
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

describe('item gate: listings read from a seed portal page', () => {
  const carKind = { label: 'used car', terms: ['used car', 'gebrauchtwagen', 'uzywany samochod', 'pouzite auto'] };
  const url = 'https://www.autoscout24.de/angebote/peugeot-208-tuev-7-27-2-zonen-leder-tempo-pdc-diesel-silber-cat_ma55gr201150ge1074va3624mt3255tr480648-d0b6741d-3dd5-47ce-804b-718ffdbb7507';
  const car = { title: 'Peugeot 208', url, value: 2999, unit: 'EUR' };
  const carOptions = { valueRange: [2000, 4000], unit: 'EUR', kind: carKind, kindKnown: true };

  it('keeps a listing of the page kind although its own title and url lack every kind term, still applying the other checks', () => {
    expect(screenItem(car, carOptions)).toMatchObject({ ok: true, priced: true });
    expect(screenItem(car, { ...carOptions, kindKnown: false }).reasons).toEqual(['not a used car']);
    expect(screenItem({ ...car, title: 'Szukam Peugeot 208' }, carOptions).reasons).toEqual(['a wanted ad, not an offer']);
    expect(screenItem({ ...car, value: 5999 }, carOptions).reasons).toEqual(['price 5999 EUR is outside 2000–4000 EUR']);
  });
});

describe('item gate: a known page kind still rejects what is sold beside the item', () => {
  const carKind = { label: 'used car', terms: ['hatchback'], not: ['kola', 'pneu', 'svetlo', 'naraznik', 'rafky', 'karburator', 'matky'] };
  const carOptions = { valueRange: [0, 65000], unit: 'CZK', kind: carKind, kindKnown: true };

  it('keeps the car and turns away parts and accessories for it', () => {
    expect(screenItem({ title: 'ŠKODA FABIA II COMFORT 2008', url: 'https://auto.bazos.cz/inzerat/225000001/skoda-fabia-ii-comfort.php', value: 49999, unit: 'CZK' }, carOptions)).toMatchObject({ ok: true, priced: true });
    expect(screenItem({ title: 'Alu kola 215x65R16', url: 'https://auto.bazos.cz/inzerat/225000002/alu-kola-215x65r16.php', value: 3500, unit: 'CZK' }, carOptions).reasons).toEqual(['not a used car']);
    expect(screenItem({ title: 'Levé zadní světlo Honda Accord 7g', url: 'https://auto.bazos.cz/inzerat/225000003/leve-zadni-svetlo-honda-accord-7g.php', value: 1500, unit: 'CZK' }, carOptions).reasons).toEqual(['not a used car']);
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

describe('items of a kind no listing portal sells', () => {
  it('reads Unicode hyphens as plain hyphens, so a model-written term like second‑hand matches', async () => {
    const { plain, isKind } = await import('../../src/research/itemgate.mjs');
    expect(plain('second\u2011hand')).toBe('second-hand');
    expect(isKind({ title: 'Wholesale second-hand clothing bales', url: 'https://bales.example.de/' }, { terms: ['wholesale second\u2011hand clothing'] })).toBe(true);
  });

  it('does not require a single listing page for a provider, only for kinds sold on listing portals', async () => {
    const { screenItem } = await import('../../src/research/itemgate.mjs');
    const provider = { title: 'Vintage wholesale bales', url: 'https://vintage-wholesale.example.de/' };
    expect(screenItem(provider, { located: true }).reasons).toContain('not a single listing page');
    expect(screenItem(provider, { located: false }).reasons).not.toContain('not a single listing page');
  });
});

describe('item gate: body variants of a swept portal page are refused like any other row', () => {
  const carKind = { label: 'used car', terms: ['used car', 'auto', 'gebrauchtwagen'], not: ['parts', 'kola'], subtype: { label: 'hatchback', models: ['fabia', 'civic', 'ibiza', 'golf', 'octavia', 'picanto'], variants: ['combi', 'sedan', 'cabrio'] } };
  const carOptions = { valueRange: [0, 65000], unit: 'CZK', kind: carKind, kindKnown: true };

  it('refuses combi, sedan, cabrio, coupe and kabriolet ads from bazos.cz and autoscout24.de', () => {
    const variants: [string, string][] = [
      ['Škoda Fabia combi 1.9 TDI 74kW, STK do 07/2028', 'https://auto.bazos.cz/inzerat/226177092/skoda-fabia-combi-19-tdi-74kw-stk-do-072028.php'],
      ['Honda Civic sedan 1.4', 'https://auto.bazos.cz/inzerat/226246758/honda-civic-sedan.php'],
      ['Seat Ibiza polocabrio 1.4 16V', 'https://auto.bazos.cz/inzerat/226126807/seat-ibiza-polocabrio-14-16v.php'],
      ['Honda Civic Coupe 1.6 LS', 'https://auto.bazos.cz/inzerat/225954846/honda-civic-coupe-16-ls.php'],
      ['Peugeot 207 CC kabriolet, platná STK', 'https://auto.bazos.cz/inzerat/226292885/peugeot-207-cc-kabriolet-platna-stk-dalnicni-znamka-fu.php'],
      ['VW Golf Variant 1.6 TDI DSG', 'https://www.autoscout24.de/angebote/vw-golf-variant-16-tdi-dsg-bluemotion-technologies-d0b6741d-3dd5-47ce-804b-718ffdbb7507'],
      ['Skoda Octavia III kombi 2.0 TDI', 'https://www.autoscout24.de/angebote/skoda-octavia-iii-kombi-20-tdi-dsg-ambition-ma55gr201150ge1074va3624mt3255tr480648-d0b6741d-3dd5-47ce-804b-718ffdbb7507'],
    ];
    for (const [title, url] of variants) {
      expect(screenItem({ title, url, value: 41000, unit: 'CZK' }, carOptions).reasons, title).toContain('a body variant (combi, sedan, cabrio, convertible, ...), not the asked body type');
    }
    expect(screenItem({ title: 'Honda Civic 1.4 i klima', url: 'https://auto.bazos.cz/inzerat/226067979/honda-civic-14-i-klima.php', value: 15000, unit: 'CZK' }, carOptions)).toMatchObject({ ok: true, priced: true });
    expect(screenItem({ title: 'Kia Picanto 1.0 45kW, 81 500 km', url: 'https://auto.bazos.cz/inzerat/225839661/kia-picanto-10-45kw-81500km.php', value: 30000, unit: 'CZK' }, carOptions).ok).toBe(true);
  });

  it('still accepts a body variant when the asked kind itself is that body type', () => {
    const wagon = { valueRange: [0, 65000], unit: 'CZK', kind: { label: 'station wagon', terms: ['station wagon', 'kombi'], subtype: { label: 'station wagon', models: ['golf'] } }, kindKnown: false };
    expect(screenItem({ title: 'VW Golf kombi 1.6 TDI', url: 'https://www.autoscout24.de/angebote/vw-golf-kombi-16-tdi-d0b6741d-3dd5-47ce-804b-718ffdbb7507', value: 8900, unit: 'EUR' }, wagon).ok).toBe(true);
  });
});

describe('item gate: instalment, leasing and deposit ads are refused', () => {
  const carKind = { label: 'used car', terms: ['used car', 'auto', 'gebrauchtwagen'], not: ['parts', 'kola'] };
  const carOptions = { valueRange: [0, 65000], unit: 'CZK', kind: carKind, kindKnown: true };

  it('refuses Czech na splátky / akontace ads priced at the deposit on bazos.cz', () => {
    expect(screenItem({ title: 'ŠKODA FABIA III 1.4 TDi na SPLÁTKY BEZ REGISTRU', url: 'https://auto.bazos.cz/inzerat/226300001/skoda-fabia-iii-14-tdi-na-splatky-bez-registru.php', value: 9900, unit: 'CZK' }, carOptions).reasons).toContain('an instalment, leasing or deposit ad, not a sale at the full price');
    expect(screenItem({ title: 'Auto na splátky, akontace 10 000 Kč, leasing', url: 'https://auto.bazos.cz/inzerat/226300002/auto-na-splatky-akontace.php', value: 10000, unit: 'CZK' }, carOptions).reasons).toContain('an instalment, leasing or deposit ad, not a sale at the full price');
  });

  it('refuses German Finanzierung / Anzahlung / Rate ads on autoscout24.de and Polish raty ads', () => {
    expect(screenItem({ title: 'Skoda Fabia III 1.4 TDI Finanzierung, Anzahlung 2.000 EUR', url: 'https://www.autoscout24.de/angebote/skoda-fabia-iii-14-tdi-finanzierung-anzahlung-2000-eur-d0b6741d-3dd5-47ce-804b-718ffdbb7507', value: 2000, unit: 'EUR' }, { ...carOptions, unit: 'EUR' }).reasons).toContain('an instalment, leasing or deposit ad, not a sale at the full price');
    expect(screenItem({ title: 'VW Golf 1.6 in Raten, Leasing möglich', url: 'https://www.autoscout24.de/angebote/vw-golf-16-in-raten-leasing-d0b6741d-3dd5-47ce-804b-718ffdbb7507', value: 199, unit: 'EUR' }, { ...carOptions, unit: 'EUR' }).reasons).toContain('an instalment, leasing or deposit ad, not a sale at the full price');
    expect(screenItem({ title: 'Sprzedam auto na raty, leasing', url: 'https://auto.bazos.cz/inzerat/226300003/sprzedam-auto-na-raty-leasing.php', value: 500, unit: 'CZK' }, carOptions).reasons).toContain('an instalment, leasing or deposit ad, not a sale at the full price');
  });

  it('keeps a plain for-sale ad whose title has none of those words', () => {
    expect(screenItem({ title: 'Dacia Sandero 1.2i LPG', url: 'https://auto.bazos.cz/inzerat/226135083/dacia-sandero-12i-lpg.php', value: 25000, unit: 'CZK' }, carOptions)).toMatchObject({ ok: true, priced: true });
  });
});

describe('item gate: car-only screens only apply to kinds that ask for a sub-type', () => {
  const plotKind = { label: 'plot of land', terms: ['plot', 'terreno'] };
  const plotOptions = { valueRange: [0, 20000], unit: 'EUR', kind: plotKind };

  it('keeps a plot listing whose title says "real estate" when the kind has no sub-type', () => {
    const listing = { title: 'Terreno rústico 5000 m2 - real estate Algarve', url: 'https://www.idealista.pt/imovel/33912345/', value: 18000, unit: 'EUR' };
    expect(screenItem(listing, plotOptions)).toMatchObject({ ok: true, priced: true });
    expect(screenItem(listing, { ...plotOptions, kind: { ...plotKind, subtype: { label: '', models: [] } } })).toMatchObject({ ok: true });
  });

  it('still screens a body variant when the car kind asks for a sub-type', () => {
    const carKind = { label: 'used car', terms: ['car', 'auto'], subtype: { label: 'hatchback', models: ['fabia'], variants: ['combi'] } };
    expect(screenItem({ title: 'Skoda Fabia Combi 1.2', url: 'https://auto.bazos.cz/inzerat/180123456/skoda-fabia-combi.php', value: 45000, unit: 'CZK' }, { valueRange: [0, 65000], unit: 'CZK', kind: carKind, kindKnown: true }).reasons).toContain('a body variant (combi, sedan, cabrio, convertible, ...), not the asked body type');
  });

  it('does not read the plain word "rate" as an instalment', () => {
    const verdict = screenItem({ title: 'Plot with high growth rate area', url: 'https://www.idealista.pt/imovel/33912346/', value: 12000, unit: 'EUR' }, plotOptions);
    expect(verdict.reasons).not.toContain('an instalment, leasing or deposit ad, not a sale at the full price');
    expect(verdict.ok).toBe(true);
  });
});
