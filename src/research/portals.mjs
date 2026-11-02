import { currencyOf } from './acceptance.mjs';

export const PORTALS_CHECKED_AT = '2026-11-01';

const pisos = (region) => `https://www.pisos.com/venta/terrenos-${region}/hasta-20000/`;
const emlakjet = (province) => `https://www.emlakjet.com/satilik-tarla/${province}`;
const imovirtual = (district) => `https://www.imovirtual.com/pt/resultados/comprar/terreno/${district}?priceMax=20000`;
const sreality = (max) => max ? `https://www.sreality.cz/hledani/prodej/pozemky?cena-do=${max}` : 'https://www.sreality.cz/hledani/prodej/pozemky';
const bezrealitky = (max) => max ? `https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek?priceTo=${max}` : 'https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek';

export const SEED_PORTALS = [
  ...['galicia', 'asturias', 'cantabria', 'andalucia', 'valencia', 'murcia', 'canarias', 'baleares'].map((r) => ({ country: 'ES', kind: 'plot of land', coastal: true, maxPrice: 20000, url: pisos(r), sample: ['terreno'] })),
  ...['mugla', 'aydin', 'izmir', 'antalya', 'mersin', 'canakkale', 'balikesir', 'tekirdag', 'sinop', 'samsun', 'trabzon'].map((p) => ({ country: 'TR', kind: 'plot of land', coastal: true, maxPrice: null, url: emlakjet(p), sample: ['tarla'] })),
  ...['viana-do-castelo', 'braga', 'porto', 'aveiro', 'coimbra', 'leiria', 'lisboa', 'setubal', 'beja', 'faro'].map((d) => ({ country: 'PT', kind: 'plot of land', coastal: true, maxPrice: 20000, url: imovirtual(d), sample: ['terreno'] })),
  ...[sreality, bezrealitky].map((url) => ({ country: 'CZ', kind: 'plot of land', coastal: false, maxPrice: null, url, sample: ['pozemek', 'pozemky'] })),
  ...['binh-thuan', 'ba-ria-vung-tau', 'khanh-hoa', 'da-nang', 'quang-nam', 'quang-ngai', 'binh-dinh', 'phu-yen', 'ninh-thuan', 'kien-giang', 'ca-mau', 'ben-tre', 'tra-vinh', 'soc-trang', 'bac-lieu', 'long-an', 'tien-giang', 'vinh-long', 'hau-giang', 'can-tho', 'an-giang', 'dong-thap', 'tay-ninh', 'binh-duong', 'binh-phuoc', 'long-an'].map((p) => ({ country: 'VN', kind: 'plot of land', coastal: true, maxPrice: null, url: `https://batdongsan.com.vn/ban-dat-dat-nen-${p}`, sample: ['đất', 'đất nền', 'bán đất'] })),
  ...['binh-thuan', 'ba-ria-vung-tau', 'khanh-hoa', 'da-nang', 'quang-nam', 'quang-ngai', 'binh-dinh', 'phu-yen', 'ninh-thuan', 'kien-giang', 'ca-mau', 'ben-tre', 'tra-vinh', 'soc-trang', 'bac-lieu', 'long-an', 'tien-giang', 'vinh-long', 'hau-giang', 'can-tho', 'an-giang', 'dong-thap', 'tay-ninh', 'binh-duong', 'binh-phuoc', 'long-an'].map((p) => ({ country: 'VN', kind: 'plot of land', coastal: true, maxPrice: null, url: `https://alonhadat.com.vn/ban-dat-${p}`, sample: ['đất', 'đất nền', 'bán đất'] })),
];

export function seedPortals(brief) {
  if (!brief?.kind || !brief.regions?.length) return [];
  const max = brief.valueRange?.[1] ?? null;
  const unit = String(brief.unit ?? '').trim();
  const czk = !unit || currencyOf(unit) === 'CZK';
  return SEED_PORTALS.filter((p) => p.kind === brief.kind.label && brief.regions.includes(p.country) && (!brief.coastal || p.coastal) && (p.maxPrice === null || max === null || p.maxPrice >= max)).map((p) => {
    const url = typeof p.url === 'function' ? p.url(czk ? max : null) : p.url;
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
