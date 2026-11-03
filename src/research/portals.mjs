import { currencyOf } from './acceptance.mjs';

export const PORTALS_CHECKED_AT = '2026-11-03';

const words = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter((word) => word.length > 2);

const withMax = (base, param) => ({ max, unit }) => (!unit || unit === 'CZK') && max !== null ? `${base}?${param}=${max}` : base;

const pisos = (region) => `https://www.pisos.com/venta/terrenos-${region}/hasta-20000/`;
const emlakjet = (province) => `https://www.emlakjet.com/satilik-tarla/${province}`;
const imovirtual = (district) => `https://www.imovirtual.com/pt/resultados/comprar/terreno/${district}?priceMax=20000`;
const sreality = withMax('https://www.sreality.cz/hledani/prodej/pozemky', 'cena-do');
const bezrealitky = withMax('https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek', 'priceTo');
const autoscout = ({ min, max, unit }) => unit === 'EUR' && min !== null && max !== null
  ? `https://www.autoscout24.de/lst?pricefrom=${min}&priceto=${max}&atype=C`
  : 'https://www.autoscout24.de/lst?atype=C';
const BAZOS_MAKES = ['skoda', 'volkswagen', 'ford', 'opel', 'peugeot', 'renault', 'hyundai', 'kia', 'toyota', 'seat', 'citroen', 'fiat', 'mazda', 'honda', 'dacia', 'suzuki', 'nissan'];
const bazos = (make) => ({ min, max, unit }) => unit === 'CZK' && min !== null && max !== null
  ? `https://auto.bazos.cz/${make}/?hledat=&cenaod=${min}&cenado=${max}`
  : `https://auto.bazos.cz/${make}/`;
const otomoto = ({ min, max, unit }) => unit === 'PLN' && min !== null && max !== null
  ? `https://www.otomoto.pl/osobowe?search%5Bfilter_float_price%3Afrom%5D=${min}&search%5Bfilter_float_price%3Ato%5D=${max}`
  : 'https://www.otomoto.pl/osobowe';

const CAR_SAMPLE = ['auto', 'car', 'cars', 'osobowe', 'samochod', 'osobni', 'vozidlo', 'gebrauchtwagen', 'pkw'];

export const SEED_PORTALS = [
  ...['galicia', 'asturias', 'cantabria', 'andalucia', 'valencia', 'murcia', 'canarias', 'baleares'].map((r) => ({ country: 'ES', kind: 'plot of land', coastal: true, currency: 'EUR', maxPrice: 20000, url: pisos(r), sample: ['terreno'] })),
  ...['mugla', 'aydin', 'izmir', 'antalya', 'mersin', 'canakkale', 'balikesir', 'tekirdag', 'sinop', 'samsun', 'trabzon'].map((p) => ({ country: 'TR', kind: 'plot of land', coastal: true, currency: 'TRY', maxPrice: null, url: emlakjet(p), sample: ['tarla'] })),
  ...['viana-do-castelo', 'braga', 'porto', 'aveiro', 'coimbra', 'leiria', 'lisboa', 'setubal', 'beja', 'faro'].map((d) => ({ country: 'PT', kind: 'plot of land', coastal: true, currency: 'EUR', maxPrice: 20000, url: imovirtual(d), sample: ['terreno'] })),
  ...[sreality, bezrealitky].map((url) => ({ country: 'CZ', kind: 'plot of land', coastal: false, currency: 'CZK', maxPrice: null, url, sample: ['pozemek', 'pozemky'] })),
  { country: 'DE', kind: 'car', coastal: false, currency: 'EUR', maxPrice: null, url: autoscout, sample: CAR_SAMPLE },
  ...BAZOS_MAKES.map((make) => ({ country: 'CZ', kind: 'car', coastal: false, currency: 'CZK', maxPrice: null, url: bazos(make), sample: CAR_SAMPLE })),
  { country: 'PL', kind: 'car', coastal: false, currency: 'PLN', maxPrice: null, url: otomoto, sample: CAR_SAMPLE },
];

const speaksOf = (portal, kind) => {
  const asked = [...(kind.terms ?? []).map((term) => words(term)).flat(), ...words(kind.label)];
  const offered = new Set([...(portal.sample ?? []).map((word) => words(word)).flat(), ...words(portal.kind)]);
  return asked.some((word) => offered.has(word));
};

const convertedBound = (value, unit, currency, convert) => {
  if (value === null || value === undefined) return null;
  const converted = convert(value, unit, currency);
  return converted === null || converted === undefined || Number.isNaN(Number(converted)) ? null : Number(converted);
};

const seedRange = (portal, { min, max }, unit, convert) => {
  if (!unit || !portal.currency || unit === portal.currency || typeof convert !== 'function') return { min, max, unit };
  const low = convertedBound(min, unit, portal.currency, convert);
  const high = convertedBound(max, unit, portal.currency, convert);
  return { min: low === null ? null : Math.floor(low), max: high === null ? null : Math.ceil(high), unit: portal.currency };
};

export function seedPortals(brief, convert = null) {
  if (!brief?.kind || !brief.regions?.length) return [];
  const [min = null, max = null] = brief.valueRange ?? [];
  const unit = currencyOf(brief.unit);
  return SEED_PORTALS.filter((p) => speaksOf(p, brief.kind) && brief.regions.includes(p.country) && (!brief.coastal || p.coastal) && (p.maxPrice === null || max === null || p.maxPrice >= max)).map((p) => {
    const url = typeof p.url === 'function' ? p.url(seedRange(p, { min, max }, unit, convert)) : p.url;
    return { url, country: p.country, sample: p.sample, count: 1, seed: true };
  });
}

export function roundRobin(pages, countryOf) {
  const groups = new Map();
  for (const page of pages) {
    const key = countryOf(page) || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  const out = [];
  for (let i = 0; out.length < pages.length; i++) for (const list of groups.values()) if (list[i]) out.push(list[i]);
  return out;
}
