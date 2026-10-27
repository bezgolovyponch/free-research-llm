export const CCI_SOURCE = 'Ma 2021, Managing Climate Change and Weather Extremes for Nature-based Tourism Organizations in the United States (University of Arkansas), ch. 2: Camping Climate Index, eq. 3 and Tables 3–4';
export const CCI_DAILY_VARS = 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,dew_point_2m_mean,sunshine_duration,precipitation_sum,wind_speed_10m_mean';

export const TC_WEIGHT = 0.5;
export const SUN_WEIGHT = 0.5;
export const ADVERSE_CAP = 3;
export const ADVERSE = { tminBelow: 8, tmaxAbove: 34, rainAbove: 10, windAbove: 23 };
export const GOOD = 5;
export const OPTIMAL = 7;
export const ACCEPTABLE = 3;
export const PERCEIVED_MAX_C = 32.2;

const TC_RATINGS = [[42, 0], [34, 7], [28, 10], [24, 9], [20, 8], [16, 7], [12, 6], [8, 5], [4, 4], [2, 3]];
const SUN_RATINGS = [[14, 10], [12, 9], [9, 8], [6, 4], [4, 2]];

export function humidex(tempC, dewPointC) {
  const vapour = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (273.15 + dewPointC)));
  return tempC + 0.5555 * (vapour - 10);
}

function rate(value, table) {
  for (const [from, rating] of table) if (value >= from) return rating;
  return 0;
}

export function tcRating(tc) {
  return rate(tc, TC_RATINGS);
}

export function sunRating(hours) {
  return rate(hours, SUN_RATINGS);
}

export function adverseDay({ tmin, tmax, rain, wind }) {
  return tmin < ADVERSE.tminBelow || tmax > ADVERSE.tmaxAbove || rain > ADVERSE.rainAbove || wind > ADVERSE.windAbove;
}

export function dailyCci(day) {
  const { tmean, dew, sunHours } = day;
  if (![tmean, dew, sunHours, day.tmin, day.tmax].every(Number.isFinite)) return null;
  const score = TC_WEIGHT * tcRating(humidex(tmean, dew)) + SUN_WEIGHT * sunRating(sunHours);
  const adverse = adverseDay({ tmin: day.tmin, tmax: day.tmax, rain: day.rain ?? 0, wind: day.wind ?? 0 });
  return adverse ? Math.min(score, ADVERSE_CAP) : score;
}

export function category(cci) {
  if (cci === null || cci === undefined) return 'unknown';
  if (cci >= OPTIMAL) return 'optimal';
  if (cci >= GOOD) return 'good';
  if (cci >= ACCEPTABLE) return 'acceptable';
  return 'unfavourable';
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export function slope(points) {
  if (points.length < 2) return null;
  const mx = mean(points.map((p) => p[0]));
  const my = mean(points.map((p) => p[1]));
  const den = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return den ? points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / den : null;
}

export function climateOf(daily) {
  const months = Array.from({ length: 12 }, () => ({ cci: [], tmax: [], tmin: [], rain: 0, years: new Set() }));
  const years = {};
  (daily?.time ?? []).forEach((date, i) => {
    const m = months[Number(date.slice(5, 7)) - 1];
    if (!m) return;
    const year = date.slice(0, 4);
    const day = { tmean: daily.temperature_2m_mean?.[i], dew: daily.dew_point_2m_mean?.[i], sunHours: (daily.sunshine_duration?.[i] ?? NaN) / 3600, tmin: daily.temperature_2m_min?.[i], tmax: daily.temperature_2m_max?.[i], rain: daily.precipitation_sum?.[i] ?? 0, wind: daily.wind_speed_10m_mean?.[i] ?? 0 };
    if (Number.isFinite(day.tmax)) m.tmax.push(day.tmax);
    if (Number.isFinite(day.tmin)) m.tmin.push(day.tmin);
    m.rain += day.rain;
    m.years.add(year);
    const y = (years[year] ??= { optimal: 0, hot: 0, days: 0 });
    if (Number.isFinite(day.tmax) && day.tmax > ADVERSE.tmaxAbove) y.hot++;
    const score = dailyCci(day);
    if (score === null) return;
    m.cci.push(score);
    y.days++;
    if (score >= OPTIMAL) y.optimal++;
  });
  const monthly = months.map((m) => ({ cci: m.cci.length ? round(mean(m.cci)) : null, tmax: m.tmax.length ? round(mean(m.tmax)) : null, tmin: m.tmin.length ? round(mean(m.tmin)) : null, rain: m.years.size ? Math.round(m.rain / m.years.size) : null }));
  const known = monthly.filter((m) => m.cci !== null && m.tmax !== null);
  if (!known.length) return null;
  const perYear = Object.entries(years).filter(([, y]) => y.days >= 300).map(([year, y]) => ({ year: Number(year), optimal: y.optimal, hot: y.hot }));
  const trend = slope(perYear.map((y) => [y.year, y.optimal]));
  return {
    workable: monthly.filter((m) => m.cci !== null && m.cci >= GOOD).length,
    comfortable: monthly.filter((m) => m.cci !== null && m.cci >= OPTIMAL).length,
    acceptable: monthly.filter((m) => m.cci !== null && m.cci >= ACCEPTABLE).length,
    hottest: Math.max(...known.map((m) => m.tmax)),
    coldest: Math.min(...known.map((m) => m.tmin)),
    months: monthly,
    cci: {
      annual: round(mean(known.map((m) => m.cci))),
      optimalDays: perYear.length ? Math.round(mean(perYear.map((y) => y.optimal))) : null,
      hotDays: perYear.length ? round(mean(perYear.map((y) => y.hot))) : null,
      perYear,
      optimalTrend: trend === null ? null : round(trend),
      years: perYear.length,
    },
  };
}
