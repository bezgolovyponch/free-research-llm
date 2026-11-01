import { describe, expect, it } from 'vitest';
import { ParcelRegistry, TurkeyParcelRegistry, cadastreNotes, listingParcel, registryArea } from '../../src/research/parcels.mjs';

const page = (props: Record<string, string>, lat = '36.56038530967912', lon = '33.88121578796138') => `<script type="application/ld+json">{"additionalProperty":[${Object.entries(props).map(([name, value]) => `{"@type":"PropertyValue","name":"${name}","value":"${value}"}`).join(',')}]}</script><script>self.__next_f.push([1,"{\\"lat\\":${lat},\\"lon\\":${lon}}"])</script>`;
const square = (lat: number, lon: number, d = 0.0005) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const feature = (lat: number, lon: number, props: Record<string, unknown>) => ({ type: 'Feature', geometry: square(lat, lon), properties: { mahalleId: 169892, mahalleAd: 'Çaltıbozkır', ...props } });

describe('listingParcel', () => {
  it('reads ada, parsel, zoning and the map point a Turkish listing page publishes', () => {
    expect(listingParcel(page({ Ada: '105', Parsel: '556', 'İmar Durumu': 'Tarla' }))).toEqual({ ada: '105', parsel: '556', zoning: 'Tarla', lat: 36.56038530967912, lon: 33.88121578796138 });
    expect(listingParcel(page({ 'İmar Durumu': 'Tarla' })).parsel).toBeNull();
  });
});

describe('registryArea', () => {
  it('reads both number formats the registry returns', () => {
    expect(registryArea('2.085,58')).toBe(2085.58);
    expect(registryArea('19,058,999.74')).toBe(19058999.74);
    expect(registryArea('846.73')).toBe(846.73);
    expect(registryArea('')).toBeNull();
  });
});

describe('cadastreNotes', () => {
  const record = { registry: 'TKGM', place: 'Çaltıbozkır', ada: '105', parsel: '556', areaM2: 2085.58, landUse: 'Tarla' };
  it('supports a listing whose area matches the official record', () => {
    expect(cadastreNotes({ cadastre: record }, 2000)).toEqual({ why: ['official record TKGM Çaltıbozkır 105/556: 2,086 m² (Tarla), matches the listing'], risks: [] });
  });
  it('flags a listing that sells part of a registered parcel as a likely shared title', () => {
    expect(cadastreNotes({ cadastre: record }, 506).risks[0]).toContain('sells 506 m² of a 2,086 m² parcel');
  });
  it('flags a listing that states more than the record and forest land', () => {
    const notes = cadastreNotes({ cadastre: { ...record, landUse: 'Orman' } }, 5000);
    expect(notes.risks).toHaveLength(2);
    expect(notes.risks[1]).toContain('forestry permit');
  });
  it('adds nothing without a registry record', () => {
    expect(cadastreNotes({}, 500)).toEqual({ why: [], risks: [] });
  });
});

describe('TurkeyParcelRegistry', () => {
  const lat = 36.56038530967912;
  const lon = 33.88121578796138;
  it('keeps the parcel at the listing point when its number matches the listing', async () => {
    const calls: string[] = [];
    const registry = new TurkeyParcelRegistry({ fetchJson: async (url: string) => { calls.push(url); return feature(lat, lon, { adaNo: '105', parselNo: '556', alan: '2.085,58', nitelik: 'Tarla' }); }, sleep: async () => {} });
    expect(await registry.find({ ada: '105', parsel: '556', lat, lon })).toMatchObject({ place: 'Çaltıbozkır', ada: '105', parsel: '556', areaM2: 2085.58, landUse: 'Tarla' });
    expect(calls).toHaveLength(1);
  });
  it('asks for the exact parcel in the same village when the blurred point lands on a neighbour', async () => {
    const replies = [feature(lat, lon, { adaNo: '109', parselNo: '1', alan: '19,058,999.74', nitelik: 'Orman' }), feature(lat + 0.004, lon, { adaNo: '105', parselNo: '556', alan: '2.085,58', nitelik: 'Tarla' })];
    const calls: string[] = [];
    const registry = new TurkeyParcelRegistry({ fetchJson: async (url: string) => { calls.push(url); return replies.shift(); }, sleep: async () => {} });
    expect(await registry.find({ ada: '105', parsel: '556', lat, lon })).toMatchObject({ parsel: '556', areaM2: 2085.58, landUse: 'Tarla' });
    expect(calls[1]).toMatch(/\/169892\/105\/556$/);
  });
  it('refuses a same-numbered parcel far from the listing point', async () => {
    const replies = [feature(lat, lon, { adaNo: '109', parselNo: '1' }), feature(lat + 0.2, lon, { adaNo: '105', parselNo: '556', alan: '2.085,58' })];
    const registry = new TurkeyParcelRegistry({ fetchJson: async () => replies.shift(), sleep: async () => {} });
    expect(await registry.find({ ada: '105', parsel: '556', lat, lon })).toBeNull();
  });
  it('returns nothing when the point is on no parcel', async () => {
    const registry = new TurkeyParcelRegistry({ fetchJson: async () => ({ Message: 'Parsel Bulunamadı' }), sleep: async () => {} });
    expect(await registry.find({ ada: '1', parsel: '2', lat, lon })).toBeNull();
  });
});

describe('ParcelRegistry', () => {
  const record = { registry: 'TKGM', country: 'TR', place: 'Tekke', ada: '217', parsel: '2', areaM2: 17091.59, landUse: 'Tarla', url: 'https://parselsorgu.tkgm.gov.tr/' };
  const rows = [
    { url: 'https://emlak.example/a', countryCode: 'TR' },
    { url: 'https://emlak.example/b', countryCode: 'TR' },
    { url: 'https://pisos.example/c', countryCode: 'ES' },
  ];
  it('attaches the registry record only to listings that state a parcel number, within the lookup budget, and caches misses', async () => {
    const pages: Record<string, string> = { 'https://emlak.example/a': page({ Ada: '217', Parsel: '2' }), 'https://emlak.example/b': page({ 'İmar Durumu': 'Tarla' }) };
    let finds = 0;
    const parcels = new ParcelRegistry({ fetchText: async (url: string) => pages[url], registries: { TR: { find: async () => { finds += 1; return record; } } }, sleep: async () => {}, now: () => Date.parse('2026-11-01T12:00:00Z') });
    const out = await parcels.apply({ kept: rows }, { mode: 'budget' });
    expect(out.kept[0].cadastre).toMatchObject({ parsel: '2', listingZoning: null });
    expect(out.kept[1].cadastre).toBeUndefined();
    expect(out.kept[2]).toBe(rows[2]);
    expect(out.parcels).toEqual({ eligible: 2, matched: 1, missed: 1, pending: 0, failed: 0 });
    await parcels.apply({ kept: rows }, { mode: 'budget' });
    expect(finds).toBe(1);
  });
  it('reads only the cache in cache mode', async () => {
    const parcels = new ParcelRegistry({ fetchText: async () => { throw new Error('no network in cache mode'); }, registries: { TR: { find: async () => record } }, sleep: async () => {} });
    expect((await parcels.apply({ kept: rows }, { mode: 'cache' })).parcels).toEqual({ eligible: 2, matched: 0, missed: 0, pending: 2, failed: 0 });
  });
  it('counts a failed page read without caching it, so the next pass retries', async () => {
    const parcels = new ParcelRegistry({ fetchText: async () => { throw new Error('HTTP 503'); }, registries: { TR: { find: async () => record } }, sleep: async () => {} });
    const out = await parcels.apply({ kept: rows.slice(0, 1) }, { mode: 'budget' });
    expect(out.parcels.failed).toBe(1);
    expect(parcels.store.parcels).toEqual({});
  });
});
