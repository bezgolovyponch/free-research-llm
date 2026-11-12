import { describe, expect, it } from 'vitest';
import { budgetOf, buildBrief, describeBrief, isNewsPage, itemCountry, localeCountry, mentionsCoast, onConcept, radiusIn, regionLabel, regionVerdict, regionsIn, SEA_WORDS, sourceCountry } from '../../src/research/brief.mjs';

const kind = { label: 'plot of land', terms: ['land', 'terreno'] };
const plots = buildBrief({
  question: 'Find plots for glamping, 20000EUR max, mild climate, nearby sea accessible by ebike',
  acceptance: { expected: '50 Plots In EU, Vietnam and Turkey', itemCount: 50, valueRange: [0, 20000], unit: 'EUR' },
  template: { itemKind: kind },
});

describe('concept brief', () => {
  it('is built by code from the user words: kind, hard price limit, regions (EU expanded to its 27 countries), sea, exclusions', () => {
    expect(plots).toMatchObject({ kind, itemCount: 50, valueRange: [0, 20000], unit: 'EUR', groups: ['EU'], coastal: true });
    expect(plots.regions).toHaveLength(29);
    expect(plots.regions).toEqual(expect.arrayContaining(['PT', 'ES', 'HR', 'GR', 'TR', 'VN']));
    expect(plots.regions).not.toContain('US');
    expect(describeBrief(plots)).toBe([
      'Deliver: 50 single plot of land listing pages for sale',
      'Hard limit: price 0–20000 EUR',
      'Where: EU (27 countries), Turkey, Vietnam (near the sea)',
      'Exclude: offered for rent; offered as a swap; wanted ads; news, blog or guide pages; search or category pages',
    ].join('\n'));
  });

  it('narrows a group word to the members the user named anywhere, and says so', () => {
    const named = buildBrief({ question: 'Find plots near the sea', acceptance: { expected: '50 Plots In EU, Vietnam and Turkey', itemCount: 50, valueRange: [0, 20000], unit: 'EUR' }, constraints: { location: 'Spain, Portugal, Turkey' }, template: { itemKind: kind } });
    expect(named.regions).toEqual(['PT', 'ES', 'TR', 'VN']);
    expect(named.regions).not.toContain('HR');
    expect(named.groups).toEqual([]);
    expect(describeBrief(named)).toContain('Where: Portugal, Spain, Turkey, Vietnam (near the sea) · EU narrowed to Portugal, Spain, the members you named');
  });

  it('reads a country from a site name that spells it out', async () => {
    const { hostCountries } = await import('../../src/research/brief.mjs');
    expect(hostCountries('https://turkeyrealestate.com/land')).toEqual(['TR']);
    expect(hostCountries('https://imovirtual.com/x')).toEqual([]);
    expect(onConcept({ url: 'https://turkeyrealestate.com/land', title: 'Antalya land' }, { kind, regions: ['TR'] })).toBe(true);
  });

  it('has no item kind or exclusions when no list is asked for', () => {
    const memo = buildBrief({ question: 'Is it profitable to resell RAV4s from Germany in Poland?', acceptance: {}, template: { itemKind: kind } });
    expect(memo).toMatchObject({ kind: null, regions: ['DE', 'PL'], excludes: [] });
    expect(regionsIn('Türkiye and España')).toEqual(['ES', 'TR']);
  });

  it('finds a country from the site address, the page language, the page path or repeated mentions', () => {
    expect(localeCountry('pt')).toBe('PT');
    expect(localeCountry('en')).toBe('');
    expect(localeCountry('pt-BR')).toBe('BR');
    expect(sourceCountry({ url: 'https://shop.example.uy/x' })).toBe('UY');
    expect(sourceCountry({ url: 'https://imo.example/pt/resultados', locale: 'pt' })).toBe('PT');
    expect(sourceCountry({ url: 'https://agents.example/portugal/property-for-sale', text: 'UK agents' })).toBe('PT');
    expect(sourceCountry({ url: 'https://agents.example/', text: 'land in Vietnam. Vietnam coast' })).toBe('VN');
    expect(sourceCountry({ url: 'https://agents.example/', text: 'one Vietnam mention' })).toBe('');
  });

  it('takes the country the page was read for, before the address, the language or the text', () => {
    expect(sourceCountry({ url: 'https://www.pisos.com/x', country: 'ES' })).toBe('ES');
    expect(sourceCountry({ url: 'https://www.pisos.com/x', country: 'Spain' })).toBe('');
    expect(sourceCountry({ url: 'https://www.pisos.com/x', country: 'ES', locale: 'pt' })).toBe('ES');
  });

  it('places a listing by its own text first, then by the page it was found on', () => {
    expect(itemCountry({ url: 'https://famalo.hr/x', title: 'Zemljište' })).toEqual({ code: 'HR', by: 'site address' });
    expect(itemCountry({ url: 'https://agents.example/viewProperty--location--Turkey--1', title: 'Seafront land' })).toEqual({ code: 'TR', by: 'listing text' });
    expect(itemCountry({ url: 'https://imo.example/pt/anuncio/x-ID1abcd', title: 'Terreno' }, { url: 'https://imo.example/', locale: 'pt' })).toEqual({ code: 'PT', by: 'source page' });
    expect(itemCountry({ url: 'https://agents.example/ad/1', title: 'Land' })).toEqual({ code: '', by: '' });
  });

  it('keeps only on-concept web sources in a list research, and never drops user files', () => {
    expect(onConcept({ kind: 'web', url: 'https://bikes.example/range', title: 'How far an e-bike goes', text: 'battery range 40 miles' }, plots)).toBe(false);
    expect(onConcept({ kind: 'web', url: 'https://weather.example/us', title: 'Weather', text: 'United States climate' }, plots)).toBe(false);
    expect(onConcept({ kind: 'web', url: 'https://guide.example.co.uk/land', title: 'Buying land in Portugal', text: '' }, plots)).toBe(true);
    expect(onConcept({ kind: 'web', url: 'https://imo.example/terrenos', locale: 'pt', title: 'Terrenos', text: '' }, plots)).toBe(true);
    expect(onConcept({ kind: 'data', url: '', title: 'my file' }, plots)).toBe(true);
    expect(onConcept({ kind: 'web', url: 'https://bikes.example/range', title: 'e-bike' }, { ...plots, kind: null })).toBe(true);
  });

  it('flags news pages and listings that state the sea', () => {
    expect(isNewsPage('https://wiki.portal.example/tin-tuc/gift-857573')).toBe(true);
    expect(isNewsPage('https://portal.example/anuncio/terreno-ID1abcd')).toBe(false);
    expect(mentionsCoast({ url: 'https://famalo.example/zemljiste-100-m-od-mora-14501', title: 'Zemljište' })).toBe(true);
    expect(mentionsCoast({ url: 'https://imo.example/terreno-coimbra-ID1abcd', title: 'Terreno Urbano Coimbra' })).toBe(false);
  });
});

describe('a distance around a place', () => {
  it('reads the radius and the place from "within", "<n> km of/from/around" and "up to"', () => {
    expect(radiusIn('I want a hatchback to purchase within 300km from prague, hatchback under 15000 EUR')).toEqual({ km: 300, place: 'prague' });
    expect(radiusIn('land 300 km from Prague')).toEqual({ km: 300, place: 'Prague' });
    expect(radiusIn('a plot 50km around Brno, not far from the motorway')).toEqual({ km: 50, place: 'Brno' });
    expect(radiusIn('up to 75 km of Vienna and its villages')).toEqual({ km: 75, place: 'Vienna' });
  });

  it('has no radius when the place is not a place or no distance is given', () => {
    expect(radiusIn('plots at most 10 km from the sea')).toBeNull();
    expect(radiusIn('find land in Portugal')).toBeNull();
    expect(radiusIn('within 10 km')).toBeNull();
  });
});

describe('buildBrief derives valueRange from question when acceptance lacks it', () => {
  it('extracts CZK amount with "entrance investments" budget word', () => {
    const brief = buildBrief({
      question: 'Find appropriate plots eligible for glamping in Czech Republic with entrance investments 1000000 CZK - test run',
      acceptance: { expected: 'provide 10 plots that will fulfill common requirments for the plot for glamping, in glamping business, for around 1000000 price of the plot', itemCount: 10, valueRange: null, unit: '' },
      template: { itemKind: kind },
    });
    expect(brief.valueRange).toEqual([0, 1000000]);
    expect(brief.unit).toBe('CZK');
    expect(brief.valueFrom).toBe('question');
  });

  it('extracts EUR amount with "max" budget word', () => {
    const brief = buildBrief({
      question: 'Find plots 20000EUR max',
      acceptance: { expected: '', itemCount: 10, valueRange: null, unit: '' },
      template: { itemKind: kind },
    });
    expect(brief.valueRange).toEqual([0, 20000]);
    expect(brief.unit).toBe('EUR');
    expect(brief.valueFrom).toBe('question');
  });

  it('returns null for amount without currency', () => {
    const brief = buildBrief({
      question: 'budget 40000',
      acceptance: { expected: '', itemCount: 10, valueRange: null, unit: '' },
      template: { itemKind: kind },
    });
    expect(brief.valueRange).toBeNull();
    expect(brief.unit).toBe('');
    expect(brief.valueFrom).toBeNull();
  });

  it('reads a Czech cap written as do 1 000 000 Kč', () => {
    expect(budgetOf('Pozemek pro glamping do 1 000 000 Kč')).toEqual({ valueRange: [0, 1000000], unit: 'CZK' });
    expect(budgetOf('Pozemek pro glamping, 1 000 000 Kč')).toBeNull();
  });

  it('keeps acceptance valueRange when provided', () => {
    const brief = buildBrief({
      question: 'glamping in Czech Republic with entrance investments 1000000 CZK',
      acceptance: { expected: '', itemCount: 10, valueRange: [0, 500000], unit: 'EUR' },
      template: { itemKind: kind },
    });
    expect(brief.valueRange).toEqual([0, 500000]);
    expect(brief.unit).toBe('EUR');
    expect(brief.valueFrom).toBe('acceptance');
  });

  it('extracts amount when it ends the clause', () => {
    const brief = buildBrief({
      question: 'I want to buy land for glamping, budget 50000 EUR.',
      acceptance: { expected: '', itemCount: 10, valueRange: null, unit: '' },
      template: { itemKind: kind },
    });
    expect(brief.valueRange).toEqual([0, 50000]);
    expect(brief.unit).toBe('EUR');
    expect(brief.valueFrom).toBe('question');
  });

  it('ignores per-unit amounts', () => {
    const brief = buildBrief({
      question: 'land at 200 EUR per m², max 50000 EUR total',
      acceptance: { expected: '', itemCount: 10, valueRange: null, unit: '' },
      template: { itemKind: kind },
    });
    expect(brief.valueRange).toEqual([0, 50000]);
    expect(brief.unit).toBe('EUR');
    expect(brief.valueFrom).toBe('question');
  });
});

describe('onConcept for kinds not sold on listing portals', () => {
  it('keeps a source that names no asked country when the asked place is where the result is used, not where the items are', () => {
    const source = { url: 'https://vintage-wholesale.example.de/brands', title: 'Branded second-hand clothing wholesale by the kilo', text: 'Ralph Lauren, Barbour, The North Face grade A bales shipped across the EU' };
    const kind = { label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing'] };
    expect(onConcept(source, { kind, regions: ['CZ'], located: true })).toBe(false);
    expect(onConcept(source, { kind, regions: ['CZ'], located: false })).toBe(true);
  });
});

describe('region verdict for an entity list (brief.located === false)', () => {
  const regions = ['CZ'];
  const wholesale = { label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing'] };
  const zagumi = {
    kind: 'web',
    title: 'Groothandel gebruikte kleding in balen - Zagumi',
    url: 'https://www.zagumi.com/nl/used-clothing/',
    domain: 'zagumi.com',
    locale: 'en_US',
    snippet: 'Zagumi levert gebruikte kleding van topkwaliteit voor uw tweedehandskledingbedrijf. Neem contact met ons op voor meer informatie over de import en export ...',
    text: 'Groothandel gebruikte kleding in balen - Zagumi Facebook YouTube Home \n Leverancier van gebruikte kledingbalen \n Crème kwaliteit\n Kleding van crèmekwaliteit, geschikt voor de hogere markt.\n Merkartikelen\n Van luxeartikelen tot sportmerken, internationale merkartikelen behoren tot de topmerken.\n Cijfer A/B\n Flexibel en breed assortiment, inclusief klasse A en B.\n Room + Extra Mix\n Gemengde Cream grade en Extra grade, wat resulteert in nog betere kwaliteit tweedehands balen.\n Sneakers\n Ongebruikte, vlekkeloze, gesorteerde en ECHTE merksneakers in een breed scala aan maten, geschikt voor mannen en vrouwen',
  };
  const firmy = {
    kind: 'web',
    title: 'Search',
    url: 'https://en.firmy.cz/top/Obchody-a-obchudky/Bazary-a-zastavarny/Second-handy',
    domain: 'en.firmy.cz',
    locale: 'en',
    snippet: 'The 20 best companies: Second-hand textile sellers',
    text: 'The 20 best companies: Second-hand textile sellers in the Czech Republic • Firmy.cz Webová stránka je dostupná i v českém jazyce. Přejete si zobrazit českou verzi? Zobrazit českou verzi zavřít Search\n clear search Searching in location_on Czech republic The 20 best companies: Second-hand textile sellers',
  };
  const wiltex = {
    kind: 'web',
    title: 'Second-Hand Clothing Importer - Wiltex Wholesale',
    url: 'https://wiltex.eu/second-hand-clothing/',
    domain: 'wiltex.eu',
    locale: '',
    snippet: 'The reason for this is that the clothes offered are sorted and carefully selected. Cream (Class A) is the highest possible quality, among which there are brand- ...',
    text: 'The reason for this is that the clothes offered are sorted and carefully selected. Cream (Class A) is the highest possible quality, among which there are brand- ...',
  };
  const addedShippingSentence = 'We ship full pallets to the Czech Republic and Slovakia within three working days.';

  it('flags a Dutch supplier page as outside the asked country while onConcept still keeps it', () => {
    expect(regionVerdict(zagumi, regions)).toEqual({ status: 'outside', code: '', text: 'outside CZ' });
    expect(onConcept(zagumi, { kind: wholesale, regions, located: false })).toBe(true);
    expect(onConcept(zagumi, { kind: wholesale, regions, located: true })).toBe(false);
  });

  it('places a .cz directory page in the asked country', () => {
    expect(regionVerdict(firmy, regions)).toEqual({ status: 'in', code: 'CZ', text: 'in CZ' });
  });

  it('re-admits a Polish supplier page that states delivery to the asked country, only when the shipping word is near the country name', () => {
    expect(regionVerdict(wiltex, regions)).toEqual({ status: 'outside', code: '', text: 'outside CZ' });
    expect(regionVerdict({ ...wiltex, text: `${wiltex.text} ${addedShippingSentence}` }, regions)).toEqual({ status: 'ships', code: 'CZ', text: 'ships to CZ' });
    expect(regionVerdict({ ...zagumi, text: `${zagumi.text} Czech Republic` }, regions)).toEqual({ status: 'names', code: 'CZ', text: 'names CZ' });
  });

  it('has no verdict for user files or when no country is asked, and names the asked countries briefly', () => {
    expect(regionVerdict({ kind: 'data', url: '', title: 'my file' }, regions)).toBeNull();
    expect(regionVerdict(zagumi, [])).toBeNull();
    expect(regionLabel(['CZ'])).toBe('CZ');
    expect(regionLabel(['DE', 'PL', 'CZ'])).toBe('DE/PL/CZ');
    expect(regionLabel(plots.regions)).toBe('the 29 asked countries');
  });
});

describe('the sea criterion: asked by the user words, not by a coastal case', () => {
  it('asks for the sea on sea, ocean, coast, beach, seaside, shore and seafront, and nothing else', () => {
    for (const w of ['sea', 'ocean', 'coast', 'coastal', 'beach', 'seaside', 'shore', 'seafront']) expect(SEA_WORDS.test(w)).toBe(true);
    for (const w of ['lake', 'river', 'mountain', 'forest', 'plot', 'land']) expect(SEA_WORDS.test(w)).toBe(false);
  });

  it('is coastal when the words ask for the sea, and not coastal when they do not', () => {
    const coastal = buildBrief({ question: 'Find plots near the sea, 20000EUR max', acceptance: { expected: '50 plots in EU, Vietnam and Turkey', itemCount: 50, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
    expect(coastal).toMatchObject({ coastal: true, seaImpossible: false });
    const inland = buildBrief({ question: 'Find plots for glamping in the Czech Republic', acceptance: { expected: '10 plots', itemCount: 10, valueRange: [0, 1000000], unit: 'CZK' }, template: { itemKind: kind } });
    expect(inland).toMatchObject({ coastal: false, seaImpossible: false });
  });

  it('says the sea is impossible and does not apply it when every named country is landlocked', () => {
    const cz = buildBrief({ question: 'Find plots near the sea in the Czech Republic', acceptance: { expected: '10 plots', itemCount: 10, valueRange: [0, 1000000], unit: 'CZK' }, template: { itemKind: kind } });
    expect(cz).toMatchObject({ coastal: false, seaImpossible: true, regions: ['CZ'] });
    expect(describeBrief(cz)).toContain('No coastline in the countries you named: the sea criterion is not applied.');
    const both = buildBrief({ question: 'Find plots near the sea in the Czech Republic and Slovakia', acceptance: { expected: '10 plots', itemCount: 10, valueRange: [0, 1000000], unit: 'CZK' }, template: { itemKind: kind } });
    expect(both).toMatchObject({ coastal: false, seaImpossible: true, regions: ['CZ', 'SK'] });
  });

  it('still asks for the sea when one of the named countries has a coast', () => {
    const mixed = buildBrief({ question: 'Find plots near the sea in the Czech Republic and Portugal', acceptance: { expected: '10 plots', itemCount: 10, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
    expect(mixed).toMatchObject({ coastal: true, seaImpossible: false, regions: ['CZ', 'PT'] });
  });
});
