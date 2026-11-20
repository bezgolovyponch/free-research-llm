import { theilSen } from './valuation.mjs';

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function parseTimeToIndex(timeStr, period) {
  const t = String(timeStr).trim();
  const yearMatch = t.match(/(\d{4})/);
  const monthMatch = t.match(/-(\d{1,2})(?:$|-)/);
  const quarterMatch = t.match(/(\d{4})-?Q([1-4])/i) || t.match(/Q([1-4])\s*(\d{4})/i);
  const monthNameMatch = t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);

  if (quarterMatch) {
    const q = parseInt(quarterMatch[2] ?? quarterMatch[1], 10);
    const y = parseInt(quarterMatch[1] ?? quarterMatch[2], 10);
    return (y - 2000) * 4 + (q - 1);
  }
  if (monthNameMatch) {
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const m = monthNames.findIndex(n => n.toLowerCase() === monthNameMatch[1].toLowerCase()) + 1;
    const y = parseInt(monthNameMatch[2], 10);
    return (y - 2000) * 12 + (m - 1);
  }
  if (yearMatch && monthMatch) {
    const y = parseInt(yearMatch[1], 10);
    const m = parseInt(monthMatch[1], 10);
    return (y - 2000) * 12 + (m - 1);
  }
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    return (y - 2000) * 12;
  }
  return null;
}

export function aggregateObservations(observations, spec) {
  const timeCol = spec.columns.find(c => c.type === 'time');
  const entityCols = spec.columns.filter(c => c.type === 'entity');
  const valueCol = spec.columns.find(c => c.type === 'value');
  
  const groups = new Map();
  
  for (const obs of observations) {
    const timeKey = obs.time;
    const entityKey = entityCols.map(c => obs[c.name] ?? '').join('|');
    const groupKey = timeKey + '|' + entityKey;
    
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { time: timeKey, entity: entityKey, values: [], unit: obs.unit, source: obs.source, quote: obs.quote });
    }
    groups.get(groupKey).values.push(obs.value);
  }
  
  const aggregated = [];
  for (const [key, group] of groups) {
    const values = group.values;
    aggregated.push({
      time: group.time,
      entity: group.entity || null,
      median: median(values),
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      unit: group.unit,
      source: group.source,
      quote: group.quote
    });
  }
  
  return aggregated;
}

export function computeTrend(aggregated, timeCol) {
  const points = aggregated
    .map(a => ({ index: parseTimeToIndex(a.time), value: a.median }))
    .filter(p => p.index !== null && Number.isFinite(p.value))
    .sort((a, b) => a.index - b.index);
  
  if (points.length < 3) return { slope: 0, intercept: points[0]?.value ?? 0, points: points.length };
  
  const slope = theilSen(points.map(p => [p.index, p.value]));
  const meanIndex = points.reduce((s, p) => s + p.index, 0) / points.length;
  const meanValue = points.reduce((s, p) => s + p.value, 0) / points.length;
  const intercept = meanValue - slope * meanIndex;
  
  return { slope, intercept, points: points.length };
}

export function seasonalOffsets(aggregated, period) {
  if (aggregated.length < 12) return {};

  const bySeason = new Map();
  for (const a of aggregated) {
    const idx = parseTimeToIndex(a.time);
    if (idx === null) continue;
    const season = period === 'monthly' ? idx % 12 : period === 'quarterly' ? idx % 4 : idx % 12;
    if (!bySeason.has(season)) bySeason.set(season, []);
    bySeason.get(season).push(a.median);
  }

  const offsets = {};
  const overallMedian = median(aggregated.map(a => a.median).filter(Number.isFinite));
  for (const [season, values] of bySeason) {
    if (values.length >= 1) {
      offsets[season] = median(values) - overallMedian;
    }
  }
  return offsets;
}

export function forecast(aggregated, spec, horizon) {
  const timeCol = spec.columns.find(c => c.type === 'time');
  if (!timeCol) return [];
  
  const period = timeCol.quoteFromAsker?.toLowerCase().includes('month') ? 'monthly' :
                 timeCol.quoteFromAsker?.toLowerCase().includes('quarter') ? 'quarterly' : 'monthly';
  
  const trend = computeTrend(aggregated, timeCol);
  const offsets = seasonalOffsets(aggregated, period);
  const lastIdx = Math.max(...aggregated.map(a => parseTimeToIndex(a.time)).filter(Number.isFinite));
  const lastValue = aggregated.find(a => parseTimeToIndex(a.time) === lastIdx)?.median ?? 0;
  
  const fitted = aggregated.map(a => {
    const idx = parseTimeToIndex(a.time);
    if (idx === null) return null;
    let fitted = trend.intercept + trend.slope * idx;
    const season = period === 'monthly' ? idx % 12 : period === 'quarterly' ? idx % 4 : idx % 12;
    if (offsets[season] !== undefined) fitted += offsets[season];
    return { actual: a.median, fitted, residual: a.median - fitted };
  }).filter(Boolean);
  
  const residuals = fitted.map(f => f.residual).filter(Number.isFinite);
  const lowQ = quantile(residuals, 0.1);
  const highQ = quantile(residuals, 0.9);
  
  const forecastRows = [];
  for (let h = 1; h <= horizon; h++) {
    const idx = lastIdx + h;
    let value = trend.intercept + trend.slope * idx;
    const season = period === 'monthly' ? idx % 12 : period === 'quarterly' ? idx % 4 : idx % 12;
    if (offsets[season] !== undefined) value += offsets[season];
    
    let timeStr = '';
    if (period === 'monthly') {
      const y = 2000 + Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      timeStr = y + '-' + String(m).padStart(2, '0');
    } else if (period === 'quarterly') {
      const y = 2000 + Math.floor(idx / 4);
      const q = (idx % 4) + 1;
      timeStr = y + '-Q' + q;
    } else {
      timeStr = 'period-' + idx;
    }
    
    let method = 'drift + Theil-Sen';
    if (Object.keys(offsets).length > 0) method += ' + seasonal naive';
    
    forecastRows.push({
      time: timeStr,
      entity: null,
      value: Number(value.toFixed(2)),
      unit: aggregated[0]?.unit ?? '',
      type: 'forecast',
      method,
      basedOn: aggregated.length,
      low: lowQ !== null ? Number((value + lowQ).toFixed(2)) : null,
      high: highQ !== null ? Number((value + highQ).toFixed(2)) : null,
      label: 'forecast · ' + method + ' · based on ' + aggregated.length + ' observations'
    });
  }
  
  return forecastRows;
}

export function buildResultsTable(spec, aggregated, forecastRows) {
  const cols = spec.columns.map(c => c.name);
  const rows = [];
  
  for (const a of aggregated) {
    const row = { time: a.time };
    if (a.entity) row.entity = a.entity;
    row.value = a.median;
    row.unit = a.unit;
    row.type = 'observed';
    row.source = a.source;
    row.quote = a.quote;
    row.count = a.count;
    row.min = a.min;
    row.max = a.max;
    rows.push(row);
  }
  
  for (const f of forecastRows) {
    const row = { time: f.time };
    if (f.entity) row.entity = f.entity;
    row.value = f.value;
    row.unit = f.unit;
    row.type = 'forecast';
    row.method = f.method;
    row.basedOn = f.basedOn;
    row.low = f.low;
    row.high = f.high;
    row.label = f.label;
    rows.push(row);
  }
  
  return { columns: cols, rows };
}

export function askedHorizon(askerText, lastTime) {
  const years = [...String(askerText ?? '').matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const last = String(lastTime ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!years.length || !last) return 0;
  const lastYear = Number(last[1]);
  const lastMonth = Number(last[2]);
  const months = (Math.max(...years) - lastYear) * 12 + (12 - lastMonth);
  return months > 0 ? months : 0;
}
