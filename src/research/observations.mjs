import { quoteFound } from './quote.mjs';
import { plain } from './itemgate.mjs';

export function normalizeText(text) {
  return plain(String(text ?? '').replace(/\s+/g, ' ')).trim();
}

export function columnQuoteInQuestion(quote, question, expected) {
  const normQuote = normalizeText(quote);
  if (!normQuote) return false;
  const normQuestion = normalizeText(question);
  const normExpected = normalizeText(expected);
  return normQuestion.includes(normQuote) || normExpected.includes(normQuote);
}

export function numberInQuote(value, quote) {
  const numStr = String(value).replace(/[.,]/g, '');
  const normQuote = normalizeText(quote).replace(/[.,]/g, '');
  return normQuote.includes(numStr);
}

export const TIDY_COLUMNS = [{ name: 'time', type: 'time' }, { name: 'entity', type: 'entity' }, { name: 'value', type: 'value' }, { name: 'unit', type: 'unit' }];

export async function tableSpec(project, router) {
  const question = project.question ?? '';
  const expected = project.acceptance?.expected ?? '';

  const prompt = [
    { role: 'system', content: 'You propose a table specification for an analysis research. Answer with JSON only.' },
    { role: 'user', content: 'TASK=TABLE_SPEC\nQuestion: ' + question + '\nExpected result: ' + expected + '\n\nThe asker wants a table of observations. Propose:\n- observationUnit: what each row represents (one measured value of one variable, at one time, for one entity)\n- columns: array of { name, type: "time" | "entity" | "value", unit, quoteFromAsker }\n\nRules:\n- Each column must have a "quoteFromAsker" that is a verbatim substring of the question or expected result\n- Exactly one column must have type "value" (the measured variable)\n- If the request names periods (month, quarter, year, Dec 2026, etc.), include a "time" column\n- Entity columns capture grouping dimensions (the groupings the asker names)\n- The "unit" is the measurement unit from the asker\'s words (e.g., "USD/ton", "EUR", "%")\n- Output JSON only: { observationUnit, columns: [...] }' }
  ];

  const reply = await router.complete({ purpose: 'table-spec', tier: 'deep', messages: prompt });
  const proposed = reply.data ?? {};
  
  const columns = (proposed.columns ?? []).filter(col => 
    col.quoteFromAsker && columnQuoteInQuestion(col.quoteFromAsker, question, expected)
  );
  
  const hasValue = columns.some(c => c.type === 'value');
  if (!hasValue && columns.length) {
    columns[0].type = 'value';
  }
  if (!columns.length) {
    return { observationUnit: 'observation', derived: true, columns: TIDY_COLUMNS.map((c) => ({ ...c })) };
  }
  return { observationUnit: proposed.observationUnit ?? 'observation', columns };
}

export function dedupeKey(row) {
  return row.time + '|' + (row.entity ?? '') + '|' + row.value + '|' + row.source;
}

export async function extract(project, router, readPage) {
  const spec = project.results?.spec;
  if (!spec) return { spec: null, observations: [], at: new Date().toISOString() };
  
  const allObservations = [];
  const seenKeys = new Set();
  const rejected = { quote: 0, number: 0 };
  
  for (const node of project.nodes ?? []) {
    if (!node.sources?.length) continue;
    
    for (const source of node.sources) {
      if (!source.url || source.kind === 'data' || source.kind === 'node') continue;
      
      let text = source.text ?? '';
      if (!text && readPage) {
        const page = await readPage(source.url).catch(() => null);
        text = page?.text ?? '';
      }
      if (!text) continue;
      
      const prompt = [
        { role: 'system', content: 'You extract observation rows from a source. Answer with JSON only: { rows: [...] }.' },
        { role: 'user', content: 'TASK=EXTRACT_OBSERVATIONS\nSource: ' + source.url + '\nTable spec: ' + JSON.stringify(spec) + '\nText: ' + text.slice(0, 15000) + '\n\nWrite the time of each row as YYYY-MM when the source states a month, YYYY-Qn for a quarter, YYYY for a year only; leave time empty when the source states no period. Extract rows matching the spec. Each row: { time, entity, value, unit, quote }.\n- time: the period in that form\n- entity: the grouping value (as the source states it)\n- value: the numeric value\n- unit: the unit from the spec\'s value column\n- quote: the exact sentence from the text containing the value\n\nOnly extract rows where the value appears in the quote. Return { rows: [...] }.' }
      ];

      const reply = await router.complete({ purpose: 'extract-observations', tier: 'fast', messages: prompt });
      const proposed = reply.data ?? {};
      const rows = proposed.rows ?? [];
      
      const entityColNames = spec.columns.filter(c => c.type === 'entity').map(c => c.name);

      for (const row of rows) {
        if (!row.quote || !row.value) continue;
        if (!quoteFound(text, row.quote)) { rejected.quote++; continue; }
        if (!numberInQuote(row.value, row.quote)) { rejected.number++; continue; }

        const entity = entityColNames.map(name => row[name] ?? '').filter(Boolean).join('|') || null;
        const key = dedupeKey({ ...row, entity, source: source.url });
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        allObservations.push({
          time: row.time,
          entity,
          value: Number(row.value),
          unit: row.unit ?? (spec.columns.find(c => c.type === 'value')?.unit ?? ''),
          quote: row.quote,
          source: source.url,
          nodeId: node.id
        });
      }
    }
  }
  
  return { spec, observations: allObservations, rejected, at: new Date().toISOString() };
}

export async function runObservations(project, router, readPage) {
  if (project.contractClass !== 'analysis') return project;

  const spec = await tableSpec(project, router);
  project.results = { ...project.results, spec };

  const extracted = await extract(project, router, readPage);
  project.results = { ...project.results, ...extracted };

  return project;
}

export function toCSV(table) {
  if (!table?.rows?.length) return '';
  const cols = table.columns;
  const header = cols.join(',');
  const rows = table.rows.map(r =>
    cols.map(c => {
      const val = r[c];
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(',') || str.includes('"') || str.includes('\n') ? '"' + str + '"' : str;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

export function toJSON(table) {
  if (!table?.rows?.length) return '[]';
  return JSON.stringify(table.rows, null, 2);
}
