const DEMAND_VERBS = /\b(?:must|should|has to|have to|needs? to|to)?\s*(?:mention|mentions|mentioning|contain|contains|containing|include|includes|including|say|says|name|names|naming)\b\s*(?:the\s+)?(?:words?|terms?|keywords?)?\s*:?\s*([^.;!?\n]+)/gi;
const QUOTED = /["“”'‘’«»]([^"“”'‘’«»]{2,60})["“”'‘’«»]/g;
const LIST_SPLIT = /,|\band\b|\bor\b|\//i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };

function lower(value) {
  return String(value ?? '').toLowerCase();
}

export function explicitTerms(text) {
  const source = String(text ?? '');
  const terms = new Set();
  for (const match of source.matchAll(QUOTED)) terms.add(lower(match[1]).trim());
  for (const match of source.matchAll(DEMAND_VERBS)) {
    for (const part of match[1].split(LIST_SPLIT)) {
      const term = lower(part).replace(/["“”'‘’«»]/g, '').trim();
      if (term) terms.add(term);
    }
  }
  return [...terms];
}

function demanded(term, demands) {
  const t = lower(term).trim();
  return demands.some((d) => d === t || d.split(/\s+/).includes(t) || (t.includes(' ') && d.includes(t)));
}

export function statedNumbers(text) {
  const source = lower(text);
  const numbers = new Set();
  for (const match of source.matchAll(/(\d[\d\s.,]*\d|\d)(?!\d)(?:\s*(k|thousand|m|million)(?![a-z]))?/g)) {
    const digits = Number(match[1].replace(/[\s.,](?=\d{3}\b)/g, '').replace(/[\s,]/g, ''));
    if (!Number.isFinite(digits)) continue;
    const scale = match[2] === 'k' || match[2] === 'thousand' ? 1000 : match[2] === 'm' || match[2] === 'million' ? 1e6 : 1;
    numbers.add(digits * scale);
  }
  for (const [word, value] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${word}\\b`).test(source)) numbers.add(value);
  return numbers;
}

function stated(value, numbers) {
  return value === 0 || numbers.has(value);
}

function constraintText(constraints) {
  return Object.values(constraints ?? {}).map(String).join(' ');
}

export function groundCriteria(spec, { demandText = '', numberText = '' } = {}) {
  const dropped = [];
  const demands = explicitTerms(demandText);
  const numbers = statedNumbers(numberText);
  const mustMention = (spec.mustMention ?? []).filter((term) => {
    const keep = demanded(term, demands);
    if (!keep) dropped.push(`must mention "${term}"`);
    return keep;
  });
  let itemCount = spec.itemCount ?? null;
  if (itemCount && !stated(itemCount, numbers)) {
    dropped.push(`at least ${itemCount} items`);
    itemCount = null;
  }
  let valueRange = spec.valueRange ?? null;
  if (valueRange && !valueRange.every((v) => stated(v, numbers))) {
    dropped.push(`value within ${valueRange.join('–')}`);
    valueRange = null;
  }
  return { spec: { ...spec, mustMention, itemCount, valueRange }, dropped };
}

export function groundAcceptance(spec, { expected = '', question = '', constraints = {} } = {}) {
  return groundCriteria(spec, { demandText: expected, numberText: `${expected} ${question} ${constraintText(constraints)}` });
}

export function groundSpec(spec, { desired = '', request = '' } = {}) {
  return groundCriteria(spec, { demandText: desired, numberText: `${desired} ${request}` });
}

export function droppedNote(dropped) {
  return dropped.length ? `not enforced (the model inferred it, your text does not ask for it): ${dropped.join(' · ')}` : '';
}
