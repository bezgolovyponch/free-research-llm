const MAX_ROWS = 200000;
const TOP_CATEGORIES = 8;

function detectDelimiter(headerLine) {
  const counts = [',', ';', '\t', '|'].map((d) => [d, headerLine.split(d).length]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  const [header = [], ...body] = rows;
  const columns = header.map((h, i) => h.trim() || `column_${i + 1}`);
  return {
    columns,
    rows: body.map((cells) => Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? '').trim()]))),
  };
}

function asNumber(cell) {
  if (cell === '' || cell == null) return null;
  const n = Number(String(cell).replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function round(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

export function profileTable({ columns, rows }) {
  const profile = columns.map((name) => {
    const values = rows.map((r) => r[name]).filter((v) => v !== '' && v != null);
    const numbers = values.map(asNumber).filter((n) => n !== null);
    if (values.length && numbers.length / values.length >= 0.9) {
      const sorted = [...numbers].sort((a, b) => a - b);
      const mean = sorted.reduce((s, n) => s + n, 0) / sorted.length;
      return {
        name,
        type: 'number',
        count: sorted.length,
        missing: rows.length - values.length,
        min: round(sorted[0]),
        p10: round(quantile(sorted, 0.1)),
        median: round(quantile(sorted, 0.5)),
        mean: round(mean),
        p90: round(quantile(sorted, 0.9)),
        max: round(sorted[sorted.length - 1]),
      };
    }
    const freq = new Map();
    for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
    return {
      name,
      type: 'text',
      count: values.length,
      missing: rows.length - values.length,
      distinct: freq.size,
      top: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_CATEGORIES).map(([value, count]) => ({ value, count })),
    };
  });
  return { rowCount: rows.length, columns: profile };
}

export function describeProfile(profile, label = 'uploaded data') {
  const lines = [`${label}: ${profile.rowCount} rows, ${profile.columns.length} columns.`];
  for (const c of profile.columns) {
    if (c.type === 'number') lines.push(`- ${c.name} (number, n=${c.count}): min ${c.min}, p10 ${c.p10}, median ${c.median}, mean ${c.mean}, p90 ${c.p90}, max ${c.max}`);
    else lines.push(`- ${c.name} (text, ${c.distinct} distinct): ${c.top.map((t) => `${t.value} (${t.count})`).join(', ')}`);
  }
  return lines.join('\n');
}
