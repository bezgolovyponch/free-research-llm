export const PROJECT_ID = 'find-appropriate-plots-to-buy-fo-b7772e';

export function researchedNode(id = 'D1.1', parentId = 'D1') {
  return {
    id,
    parentId,
    title: 'Affordable parcels count',
    question: 'How many parcels ≤20,000 EUR exist in each country’s coastal region?',
    method: 'lookup',
    dependsOn: [],
    status: 'weak',
    attempts: 1,
    model: 'gemini/gemini-3.5-flash-lite',
    finding: {
      answer: 'There are no identified coastal land parcels in Spain, Portugal, or Turkey listed for sale at a price of 20,000 EUR or less.',
      claims: [{ text: 'There are no available coastal land parcels in Spain at or below 20,000 EUR.', value: null, unit: '', sourceIds: ['D1.1.1'], quote: 'There is no available evidence indicating that any coastal land parcels in Spain are listed for sale at 20,000 EUR or le', assumption: false, attributed: true }],
      items: [],
      confidence: 'high',
      gaps: ['Lack of data from other potential mild-climate European coastal countries meeting the criteria.'],
    },
    sources: [{ id: 'D1.1.1', kind: 'node', title: 'Spain coastal plots ≤20 000 EUR', url: '', domain: 'node:D1.1.1', text: 'There is no available evidence indicating that any coastal land parcels in Spain are listed for sale' }],
  };
}

export function driverNode(id = 'D1') {
  return {
    id,
    parentId: 'Q',
    title: 'All-in land cost (purchase + preparation)',
    question: 'For candidate coastal plots in Spain, Portugal, Turkey and Vietnam, what is the purchase price plus the estimated cost to make the land glamping-ready, in EUR?',
    method: 'lookup',
    dependsOn: [],
    status: 'weak',
    attempts: 1,
    model: 'gemini/gemini-3.5-flash-lite',
    finding: { answer: 'For coastal plots in Spain, Portugal, Turkey, and Vietnam, the total cost comprising purchase price and preparation cannot be fully determined.', claims: [], items: [], confidence: 'low', gaps: ['No data for parcel availability in Vietnam under 20,000 EUR.'] },
    sources: [{ id: 'D1.1', kind: 'node', title: 'Affordable parcels count', url: '', domain: 'node:D1.1', text: 'There are no identified coastal land parcels in Spain, Portugal, or Turkey listed for sale at a pric' }],
  };
}

export function pendingNode(id = 'D2', parentId = 'Q') {
  return { id, parentId, title: 'Legal path for a foreign buyer', question: 'Can a foreign individual buy rural land in Portugal?', method: 'lookup', dependsOn: [], status: 'pending', attempts: 0, finding: null, sources: [] };
}

export const KEPT_ROWS = [
  { title: 'Terreno para venda', url: 'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1icmH', price: 4620, currency: 'EUR', value: 4620, unit: 'EUR', area: 3080, areaUnit: 'm²', place: 'Vilarinho do Bairro, Anadia, Aveiro', country: 'Portugal', countryCode: 'PT', countryBy: 'source page', coast: false, sourceUrl: 'https://www.imovirtual.com/pt/resultados/comprar/terreno/coimbra?priceMax=20000&page=4', nodeId: 'sweep', via: ['embedded-json', 'cards'], lat: 40.4633, lon: -8.560518, site: { coastKm: 19.7 }, plan: { tier: 'fits' }, verified: { verdict: 'unconfirmed', failed: ['sea within 20 km: unconfirmed (20.1 km)'], at: '2026-11-12T13:52:18.332Z' } },
  { title: 'Terreno Agrícola Novo em Paião, Figueira da Foz', url: 'https://www.imovirtual.com/pt/anuncio/terreno-agricola-novo-em-paiao-figueira-da-foz-ID1j2CF', price: 4900, currency: 'EUR', value: 4900, unit: 'EUR', area: 1323, areaUnit: 'm²', place: 'Paião, Figueira da Foz, Coimbra', country: 'Portugal', countryCode: 'PT', countryBy: 'source page', coast: false, sourceUrl: 'https://www.imovirtual.com/pt/resultados/comprar/terreno/coimbra?priceMax=20000', nodeId: 'sweep', via: ['embedded-json', 'cards'], lat: 40.06589, lon: -8.751619, site: { coastKm: 6.5 }, plan: { tier: 'fits' }, verified: { verdict: 'confirmed', failed: [], at: '2026-11-12T13:52:18.332Z' } },
  { title: 'Terreno para venda', url: 'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1h5zV', price: 4900, currency: 'EUR', value: 4900, unit: 'EUR', area: 600, areaUnit: 'm²', place: 'Palme, Barcelos, Braga', country: 'Portugal', countryCode: 'PT', countryBy: 'source page', coast: false, sourceUrl: 'https://www.imovirtual.com/pt/resultados/comprar/terreno/braga?priceMax=20000&page=4', nodeId: 'sweep', via: ['embedded-json', 'cards'], lat: 41.586082, lon: -8.714453, site: { coastKm: 7.1 }, plan: { tier: 'fits' }, verified: { verdict: 'confirmed', failed: [], at: '2026-11-12T13:52:18.332Z' } },
];

export function sweepPage(listings = KEPT_ROWS) {
  return { url: 'https://www.imovirtual.com/pt/resultados/comprar/terreno/leiria?priceMax=20000', id: 'P1', listings: listings.map((r) => ({ title: r.title, url: r.url, value: r.price, unit: r.currency, area: r.area, place: r.place })) };
}

export function plotResearch({ nodes = [driverNode(), researchedNode(), pendingNode()], kept = KEPT_ROWS, pages = [sweepPage()] } = {}) {
  return {
    id: PROJECT_ID,
    question: 'Find appropriate plots to buy for a glamping business near the sea, 20000EUR max',
    templateId: 'glamping-location',
    phase: 'done',
    nodes: structuredClone(nodes),
    candidates: { found: 2950, kept: structuredClone(kept), keptCount: kept.length, toCheck: [], outside: [], screened: {}, screenedCount: 0 },
    sweep: { pages: structuredClone(pages), pagesRead: pages.length, budget: 90, at: '2026-11-12T13:05:35.691Z', arms: [] },
    report: null,
    log: [],
  };
}
