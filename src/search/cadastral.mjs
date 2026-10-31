import { fetchJson } from './search.mjs';

export const OPEN_FOR_QUOTA = Symbol('open-for-quota');

const OVERPASS_HOSTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const OVERPASS_TEMPLATE = {
  id: 'overpass-parcel-boundaries',
  label: 'OpenStreetMap parcel & boundary polygons (Overpass API, open-source template)',
  kind: 'overpass',
  freeTier: 'no key required; shared public instances, one query at a time',
  buildQuery: (lat, lon, radiusM) => `[out:json][timeout:25];(node["landuse"](around:${radiusM},${lat},${lon});way["landuse"](around:${radiusM},${lat},${lon});relation["landuse"](around:${radiusM},${lat},${lon}););out center tags;`,
};

const CADASTRAL_PORTALS = {
  TR: {
    id: 'tapu-public',
    label: 'Türkiye tapu ve kadastro resmi ilanları (general information portal)',
    kind: 'portal',
    freeTier: 'public parcel query by address/parcel',
    exampleUrl: 'https://gm-tkbm.tkgm.gov.tr/',
    notes: 'official title/ownership lookup requires e-Devlet login; public pages give parcel boundaries and zoning hints',
  },
  PT: {
    id: 'cpd-public',
    label: 'Portugal CPD / Predial (land registry & tax matrix)',
    kind: 'portal',
    freeTier: 'public parcel search by municipality + article',
    exampleUrl: 'https://www.cm-lisboa.pt/',
    notes: 'matrix (caderneta predial) and land registry (registo predial) are separate public queries',
  },
  ES: {
    id: 'catastro-public',
    label: 'Spain Catastro (parcel reference, surface, use, value)',
    kind: 'portal',
    freeTier: 'public parcel search by cadastral reference or address',
    exampleUrl: 'https://www.sede.catastro.gob.es/',
    notes: 'provides referencia catastral, superficie, uso, valor catastral; ownership needs nota simple',
  },
};

export function cadastralPortal(countryCode) {
  return CADASTRAL_PORTALS[countryCode] ?? null;
}

export function overpassQuery(lat, lon, radiusM = 2000) {
  const hosts = [...OVERPASS_HOSTS];
  for (let i = hosts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [hosts[i], hosts[j]] = [hosts[j], hosts[i]];
  }
  return { hosts, query: OVERPASS_TEMPLATE.buildQuery(lat, lon, radiusM) };
}

export class CadastralScraper {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.attempts = new Map();
  }

  async boundaries(lat, lon, radiusM, fetchImpl = fetch) {
    const { hosts, query } = overpassQuery(lat, lon, radiusM);
    const lastErr = [];
    for (const host of hosts) {
      const key = `${host}|${radiusM}`;
      const attempt = this.attempts.get(key) ?? 0;
      if (attempt >= 2) continue;
      try {
        const body = await fetchJson(fetchImpl, host, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'free-research-llm/1.0' },
          body: `data=${encodeURIComponent(query)}`,
        }, 40000);
        this.attempts.set(key, 0);
        const elements = (body.elements ?? []).filter((e) => e.type === 'way' || e.type === 'relation');
        return { source: host, parcels: elements.map((e) => ({ id: `${e.type}${e.id}`, lat: e.lat ?? (e.center ?? {}).lat, lon: e.lon ?? (e.center ?? {}).lon, tags: e.tags ?? {}, areaM2: e.tags?.area })), error: '' };
      } catch (error) {
        lastErr.push(`${host}: ${String(error.message).slice(0, 120)}`);
        this.attempts.set(key, attempt + 1);
      }
    }
    return { source: null, parcels: [], error: lastErr.join('; ') };
  }

  portalUrl(countryCode, parcelRef) {
    const portal = CADASTRAL_PORTALS[countryCode];
    if (!portal) return null;
    return { ...portal, query: parcelRef };
  }
}

export const CADASTRAL_GATES = [
  { id: 'parcelExists', label: 'a cadastral parcel record exists for this reference' },
  { id: 'boundariesMapped', label: 'parcel boundaries are mapped (not just a point)' },
  { id: 'ownershipClear', label: 'title shows a single clear owner (no shared title / no encumbrance found)' },
  { id: 'zoningAllows', label: 'zoning permits the intended use (not industrial-only, not protected-area)' },
  { id: 'surfaceKnown', label: 'surface area in m² is stated on the record' },
  { id: 'pricePerM2Known', label: 'recent comparable price per m² exists for the same zone' },
];

export function cadastralCheck(row, gateId) {
  const finding = row.finding ?? {};
  const hasRecord = Boolean(finding.parcelRef || finding.cadastralRef);
  switch (gateId) {
    case 'parcelExists':
      return { id: 'parcelExists', ok: hasRecord ? true : null, detail: hasRecord ? `cadastral reference ${finding.parcelRef}` : 'no cadastral reference found — not measured yet' };
    case 'boundariesMapped':
      return { id: 'boundariesMapped', ok: finding.boundaryCount && finding.boundaryCount > 0 ? true : null, detail: finding.boundaryCount ? `${finding.boundaryCount} boundary elements mapped` : 'boundaries not mapped — not measured yet' };
    case 'ownershipClear':
      if (finding.sharedTitle === true) return { id: 'ownershipClear', ok: false, detail: 'shared title (hisseli): buys a share, not a parcel' };
      if (finding.encumbrance === true) return { id: 'ownershipClear', ok: false, detail: 'encumbrance on title' };
      return { id: 'ownershipClear', ok: hasRecord ? true : null, detail: hasRecord ? 'title shows a single clear owner' : 'ownership status not yet verified' };
    case 'zoningAllows':
      if (finding.zoning === 'industrial') return { id: 'zoningAllows', ok: false, detail: 'industrial zone: camping/glamping must be distant from insalubrious industry' };
      if (finding.protected === true) return { id: 'zoningAllows', ok: false, detail: 'protected area' };
      return { id: 'zoningAllows', ok: hasRecord ? true : null, detail: hasRecord ? 'zoning permits the intended use' : 'zoning not yet read' };
    case 'surfaceKnown':
      return { id: 'surfaceKnown', ok: Number.isFinite(finding.surfaceM2) ? true : null, detail: finding.surfaceM2 ? `${finding.surfaceM2} m²` : 'surface not stated — not measured yet' };
    case 'pricePerM2Known':
      return { id: 'pricePerM2Known', ok: Number.isFinite(finding.pricePerM2) ? true : null, detail: finding.pricePerM2 ? `€${finding.pricePerM2.toFixed(2)}/m² comparable` : 'no comparable price per m² yet' };
    default: return { id: gateId, ok: null, detail: 'gate not measured yet' };
  }
}

export function cadastralFinding(finding) {
  const fields = { ...finding };
  for (const c of finding.claims ?? []) {
    const t = String(c.text ?? '').toLowerCase();
    const v = c.value;
    const quote = String(c.quote ?? c.text ?? '');
    if (fields.parcelRef == null && /cadastral|parcel|tapu|cadastre/.test(t)) {
      const m = quote.match(/[\d]{1,6}[\/\-.][\d]{1,6}/);
      if (m) fields.parcelRef = m[0];
    }
    if (fields.boundaryCount == null && /boundary|limit|border|edge/.test(t) && Number.isFinite(Number(v))) fields.boundaryCount = Number(v);
    if (fields.surfaceM2 == null && /surface|area|m²|sq ?m/.test(t) && Number.isFinite(Number(v))) fields.surfaceM2 = Number(v);
    if (fields.pricePerM2 == null && /price per m|per m²|per m2|€\/m/.test(t) && Number.isFinite(Number(v))) fields.pricePerM2 = Number(v);
    if (fields.zoning == null && /zoning|zone/.test(t) && quote.trim()) fields.zoning = quote.trim().toLowerCase();
    if (/shared title|hisseli|quota part|quota-part/.test(t)) fields.sharedTitle = true;
    if (/encumbrance|charge|lien|mortgage/.test(t)) fields.encumbrance = true;
    if (/protected|heritage|nature reserve|reserva/.test(t)) fields.protected = true;
  }
  return fields;
}

export function cadastralTree(parentId, countryCode, parcelRef) {
  const next = (...ns) => `${parentId}.${ns.join('.')}`;
  const portal = cadastralPortal(countryCode);
  const nodes = [
    { id: next(1), title: 'Cadastral record exists', question: `Does a cadastral/land-registry record exist for ${parcelRef ?? 'this parcel'} in ${countryCode}?`, method: 'lookup', searchQueries: [`${countryCode} cadastral parcel ${parcelRef ?? ''} search`, `cadastre ${countryCode} parcel reference`], sourceUrls: portal ? [portal.exampleUrl] : [], impact: 5, uncertainty: 4 },
    { id: next(1, 1), title: 'Parcel boundaries mapped', question: `Are the boundaries of ${parcelRef ?? 'the parcel'} mapped on the cadastral map or OpenStreetMap?`, method: 'lookup', dependsOn: [next(1)], impact: 4, uncertainty: 3 },
    { id: next(1, 2), title: 'Ownership & title status', question: `Who owns ${parcelRef ?? 'the parcel'} and is the title clear (single owner, no shared title, no encumbrance)?`, method: 'lookup', dependsOn: [next(1)], impact: 5, uncertainty: 4 },
    { id: next(1, 3), title: 'Zoning & permitted use', question: `What is the zoning of ${parcelRef ?? 'the parcel'} and does it permit glamping / rural camping?`, method: 'lookup', dependsOn: [next(1, 2)], impact: 5, uncertainty: 4 },
    { id: next(2), title: 'Surface & price per m²', question: `What is the surface in m² and the recent price per m² for comparable parcels near ${parcelRef ?? 'this parcel'}?`, method: 'calculation', dependsOn: [next(1, 1)], impact: 3, uncertainty: 3 },
  ];
  return nodes.map((n) => {
    const parts = n.id.split('.');
    parts.pop();
    return { ...n, parentId: parts.join('.') || parentId };
  });
}
