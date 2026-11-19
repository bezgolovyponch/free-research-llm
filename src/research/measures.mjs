import { areaM2 } from './site.mjs';
import { explorePoints } from './site.mjs';
import { plain } from './itemgate.mjs';

const finite = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n) : undefined);
const climateOf = (row) => (row.site?.climate?.cci ? row.site.climate : undefined);

export const MEASURES = {
  priceEur: { label: 'asking price', unit: 'EUR', read: (row) => finite(row.value) },
  distanceKm: { label: 'distance from asked place', unit: 'km', read: (row) => finite(row.distanceKm) },
  areaM2: { label: 'land area', unit: 'm2', read: (row) => areaM2(row) ?? undefined },
  coastKm: { label: 'distance to the sea', unit: 'km', read: (row) => (row.site ? row.site.coastKm ?? Infinity : undefined) },
  beachKm: { label: 'distance to a beach', unit: 'km', read: (row) => (row.site ? row.site.beachKm ?? Infinity : undefined) },
  lakeKm: { label: 'distance to a named lake or reservoir', unit: 'km', read: (row) => (row.site ? (row.site.lakesNamed ? row.site.lakeKm ?? Infinity : Infinity) : undefined) },
  workableMonths: { label: 'camping months a year (Camping Climate Index above 3, acceptable or better, Ma 2021 Table 4; 2025 daily weather per 0.25 deg cell, Open-Meteo)', unit: 'months', read: (row) => climateOf(row)?.workable },
  comfortableMonths: { label: 'optimal camping months a year (Camping Climate Index >= 7)', unit: 'months', read: (row) => climateOf(row)?.comfortable },
  optimalDays: { label: 'optimal camping days a year (Camping Climate Index >= 7)', unit: 'days', read: (row) => climateOf(row)?.cci?.optimalDays ?? undefined },
  hotDays: { label: 'days a year above 34 °C', unit: 'days', read: (row) => climateOf(row)?.cci?.hotDays ?? undefined },
  hottestC: { label: 'hottest month average daily high', unit: '°C', read: (row) => climateOf(row)?.hottest },
  coldestC: { label: 'coldest month average daily low', unit: '°C', read: (row) => climateOf(row)?.coldest },
  explorePoints: { label: 'beaches, viewpoints, sights, reserves and trails within 15 km', unit: 'places', read: (row) => (row.site ? explorePoints(row.site) : undefined) },
  staysNearby: { label: 'campsites and lodging within 15 km', unit: 'places', read: (row) => (row.site ? (row.site.lodging ?? 0) + (row.site.campsites ?? 0) : undefined) },
  realTrendVsEu: { label: 'country real house-price trend minus the EU average', unit: 'points a year', read: (row, ctx) => {
    const hpi = ctx?.trends?.[row.countryCode]?.real ?? row.fit?.hpi;
    return finite(hpi) !== undefined && finite(ctx?.euHpi) !== undefined ? Math.round((hpi - ctx.euHpi) * 10) / 10 : undefined;
  } },
};

export function compare(value, op, limit) {
  if (op === '<=') return value <= limit;
  if (op === '>=') return value >= limit;
  if (op === '<') return value < limit;
  return value > limit;
}

export function adaptForChecklist(measures) {
  return Object.fromEntries(
    Object.entries(measures).map(([key, m]) => [key, {
      read: (row, ctx) => {
        const val = m.read(row, ctx);
        return val === Infinity ? undefined : val;
      },
    }])
  );
}
