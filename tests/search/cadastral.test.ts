import { describe, expect, it } from 'vitest';
import { CADASTRAL_GATES, cadastralCheck, cadastralPortal, overpassQuery } from '../../src/search/cadastral.mjs';
import { CadastralScraper } from '../../src/search/cadastral.mjs';

describe('cadastral portal', () => {
  it('returns a public cadastral portal per supported country', () => {
    expect(cadastralPortal('TR').id).toBe('tapu-public');
    expect(cadastralPortal('PT').id).toBe('cpd-public');
    expect(cadastralPortal('ES').id).toBe('catastro-public');
    expect(cadastralPortal('ZZ')).toBeNull();
  });
});

describe('overpassQuery', () => {
  it('shuffles hosts and builds a polygon query around a point', () => {
    const { hosts, query } = overpassQuery(41.0, 29.0, 2000);
    expect(Array.isArray(hosts) && hosts.length >= 2).toBe(true);
    expect(query).toContain('out:json');
    expect(query).toContain('around:2000,41,29');
  });
});

describe('CadastralScraper.boundaries', () => {
  it('parses parcel boundaries from the first healthy Overpass instance', async () => {
    const fetched: string[] = [];
    const body = { elements: [{ type: 'way', id: 7, center: { lat: 41.0, lon: 29.0 }, tags: { landuse: 'farm' } }] };
    const fetchImpl = async (_url: string) => {
      fetched.push(_url);
      return { ok: true, json: async () => body };
    };
    const scraper = new CadastralScraper();
    const result = await scraper.boundaries(41.0, 29.0, 2000, fetchImpl);
    expect(result.source).toBeTruthy();
    expect(result.parcels.length).toBe(1);
    expect(result.parcels[0].id).toBe('way7');
    expect(result.error).toBe('');
  });

  it('records failures and moves to the next host', async () => {
    const fetchImpl = async () => { throw new Error('502 Bad Gateway'); };
    const scraper = new CadastralScraper();
    const result = await scraper.boundaries(41.0, 29.0, 2000, fetchImpl);
    expect(result.source).toBeNull();
    expect(result.parcels.length).toBe(0);
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe('CADASTRAL_GATES', () => {
  it('defines six gates spanning record, boundary, ownership, zoning, surface and price', () => {
    expect(CADASTRAL_GATES.length).toBe(6);
    const ids = CADASTRAL_GATES.map((g) => g.id);
    expect(ids).toEqual(['parcelExists', 'boundariesMapped', 'ownershipClear', 'zoningAllows', 'surfaceKnown', 'pricePerM2Known']);
  });
});

describe('cadastralCheck', () => {
  const row = (finding: Record<string, unknown>) => ({ finding });

  it('parcelExists passes when a reference is on record and is pending without one', () => {
    expect(cadastralCheck(row({ parcelRef: '33/1234' }), 'parcelExists').ok).toBe(true);
    expect(cadastralCheck(row({}), 'parcelExists').ok).toBe(null);
  });

  it('boundariesMapped passes when boundary elements exist and is pending without them', () => {
    expect(cadastralCheck(row({ boundaryCount: 4 }), 'boundariesMapped').ok).toBe(true);
    expect(cadastralCheck(row({}), 'boundariesMapped').ok).toBe(null);
  });

  it('ownershipClear fails on shared title or encumbrance and is pending without a record', () => {
    expect(cadastralCheck(row({ sharedTitle: true }), 'ownershipClear').ok).toBe(false);
    expect(cadastralCheck(row({ encumbrance: true }), 'ownershipClear').ok).toBe(false);
    expect(cadastralCheck(row({}), 'ownershipClear').ok).toBe(null);
  });

  it('zoningAllows fails on industrial zone or protected area and is pending without a record', () => {
    expect(cadastralCheck(row({ zoning: 'industrial' }), 'zoningAllows').ok).toBe(false);
    expect(cadastralCheck(row({ protected: true }), 'zoningAllows').ok).toBe(false);
    expect(cadastralCheck(row({}), 'zoningAllows').ok).toBe(null);
  });

  it('surfaceKnown and pricePerM2Known pass when the value is finite and are pending without it', () => {
    expect(cadastralCheck(row({ surfaceM2: 5000 }), 'surfaceKnown').ok).toBe(true);
    expect(cadastralCheck(row({}), 'surfaceKnown').ok).toBe(null);
    expect(cadastralCheck(row({ pricePerM2: 47.5 }), 'pricePerM2Known').ok).toBe(true);
    expect(cadastralCheck(row({}), 'pricePerM2Known').ok).toBe(null);
  });

  it('unknown gate returns null', () => {
    expect(cadastralCheck(row({}), 'noSuchGate').ok).toBeNull();
  });
});
