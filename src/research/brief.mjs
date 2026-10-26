import { plain } from './itemgate.mjs';

export const COUNTRIES = [
  ['AT', 'Austria', ['osterreich'], 'EU'],
  ['BE', 'Belgium', ['belgique', 'belgie'], 'EU'],
  ['BG', 'Bulgaria', ['balgariya', 'българия'], 'EU'],
  ['HR', 'Croatia', ['hrvatska'], 'EU'],
  ['CY', 'Cyprus', ['kibris', 'kypros'], 'EU'],
  ['CZ', 'Czechia', ['czech republic', 'cesko'], 'EU'],
  ['DK', 'Denmark', ['danmark'], 'EU'],
  ['EE', 'Estonia', ['eesti'], 'EU'],
  ['FI', 'Finland', ['suomi'], 'EU'],
  ['FR', 'France', [], 'EU'],
  ['DE', 'Germany', ['deutschland'], 'EU'],
  ['GR', 'Greece', ['hellas', 'ellada', 'grecia', 'griechenland', 'ελλάδα'], 'EU'],
  ['HU', 'Hungary', ['magyarorszag'], 'EU'],
  ['IE', 'Ireland', ['eire'], 'EU'],
  ['IT', 'Italy', ['italia'], 'EU'],
  ['LV', 'Latvia', ['latvija'], 'EU'],
  ['LT', 'Lithuania', ['lietuva'], 'EU'],
  ['LU', 'Luxembourg', [], 'EU'],
  ['MT', 'Malta', [], 'EU'],
  ['NL', 'Netherlands', ['nederland', 'holland'], 'EU'],
  ['PL', 'Poland', ['polska'], 'EU'],
  ['PT', 'Portugal', [], 'EU'],
  ['RO', 'Romania', [], 'EU'],
  ['SK', 'Slovakia', ['slovensko'], 'EU'],
  ['SI', 'Slovenia', ['slovenija'], 'EU'],
  ['ES', 'Spain', ['espana', 'espanya'], 'EU'],
  ['SE', 'Sweden', ['sverige'], 'EU'],
  ['TR', 'Turkey', ['turkiye', 'turquia', 'turquie', 'turkei'], ''],
  ['VN', 'Vietnam', ['viet nam'], ''],
  ['AL', 'Albania', ['shqiperia'], ''],
  ['ME', 'Montenegro', ['crna gora'], ''],
  ['GE', 'Georgia', ['sakartvelo'], ''],
  ['MA', 'Morocco', ['maroc'], ''],
  ['TH', 'Thailand', [], ''],
  ['GB', 'United Kingdom', ['uk', 'england', 'scotland', 'wales'], ''],
  ['US', 'United States', ['usa', 'u.s.'], ''],
  ['BR', 'Brazil', ['brasil'], ''],
  ['AU', 'Australia', [], ''],
  ['NZ', 'New Zealand', [], ''],
  ['CA', 'Canada', [], ''],
  ['MX', 'Mexico', ['mexico'], ''],
  ['UY', 'Uruguay', [], ''],
  ['AR', 'Argentina', [], ''],
  ['CL', 'Chile', [], ''],
  ['CO', 'Colombia', [], ''],
  ['PE', 'Peru', [], ''],
  ['EC', 'Ecuador', [], ''],
  ['CR', 'Costa Rica', [], ''],
  ['PA', 'Panama', [], ''],
  ['DO', 'Dominican Republic', [], ''],
  ['ZA', 'South Africa', [], ''],
  ['EG', 'Egypt', [], ''],
  ['TN', 'Tunisia', [], ''],
  ['IN', 'India', [], ''],
  ['LK', 'Sri Lanka', [], ''],
  ['ID', 'Indonesia', ['bali'], ''],
  ['PH', 'Philippines', [], ''],
  ['MY', 'Malaysia', [], ''],
  ['KH', 'Cambodia', [], ''],
  ['JP', 'Japan', [], ''],
  ['CN', 'China', [], ''],
  ['RS', 'Serbia', ['srbija'], ''],
  ['BA', 'Bosnia and Herzegovina', ['bosnia'], ''],
  ['MK', 'North Macedonia', ['macedonia'], ''],
  ['UA', 'Ukraine', [], ''],
  ['RU', 'Russia', [], ''],
  ['NO', 'Norway', ['norge'], ''],
  ['CH', 'Switzerland', ['schweiz', 'suisse', 'svizzera'], ''],
  ['IS', 'Iceland', [], ''],
];
const ONE_COUNTRY_LANGUAGES = { pt: 'PT', el: 'GR', tr: 'TR', vi: 'VN', hr: 'HR', bg: 'BG', it: 'IT', ro: 'RO', pl: 'PL', cs: 'CZ', sk: 'SK', sl: 'SI', hu: 'HU', fi: 'FI', sv: 'SE', da: 'DK', et: 'EE', lv: 'LV', lt: 'LT', sq: 'AL', ka: 'GE' };
const GROUPS = { EU: /\b(?:eu|european union|e\.u\.)\b/ };
const GENERIC_TLDS = new Set(['co', 'io', 'ai', 'me', 'tv', 'cc', 'fm', 'ly', 'to', 'gg', 'app']);
const TLD_ALIASES = { uk: 'GB' };
const COAST = /\b(?:sea|ocean|coast(?:al)?|beach|seaside|shore|seafront)\b/;
const COAST_ON_PAGE = /\b(?:sea|ocean|coast|coastal|beach|seaside|seafront|sea view|praia|playa|plage|spiaggia|mar|deniz|denize|sahil|plaj|bai bien|gan bien|thalassa|paralia|strand|kust|mora|uvala|uvale|pogled na more|plaza|plazi|bord de mer|vista mare|frente mar|denize sifir)\b/;
const NEWS_PATH = /\/(?:news|noticias|noticia|blog|tin-tuc|tin-thi-truong|haber|actualite|articles?|magazine|guide|guides|deco)(?:\/|$|-)/i;
const MIN_TEXT_MENTIONS = 2;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text, word) {
  return new RegExp(`(?:^|[^a-z])${escape(plain(word))}(?![a-z])`).test(text);
}

function countMentions(text, word) {
  return (text.match(new RegExp(`(?:^|[^a-z])${escape(plain(word))}(?![a-z])`, 'g')) ?? []).length;
}

export function countryByCode(code) {
  const row = COUNTRIES.find(([c]) => c === code);
  return row ? { code: row[0], name: row[1], aliases: row[2], group: row[3] } : null;
}

function namesOf(code) {
  const c = countryByCode(code);
  return c ? [c.name, ...c.aliases] : [];
}

function namedCountries(text) {
  const t = plain(text);
  return COUNTRIES.filter(([, name, aliases]) => [name, ...aliases].some((w) => mentions(t, w))).map(([code]) => code);
}

function groupsIn(text) {
  return Object.keys(GROUPS).filter((g) => GROUPS[g].test(plain(text)));
}

function membersOf(group) {
  return COUNTRIES.filter((row) => row[3] === group).map(([code]) => code);
}

export function openGroups(text) {
  const named = new Set(namedCountries(text));
  return groupsIn(text).filter((g) => !membersOf(g).some((code) => named.has(code)));
}

export function regionsIn(text) {
  const codes = new Set(openGroups(text).flatMap(membersOf));
  for (const code of namedCountries(text)) codes.add(code);
  return [...codes];
}

function narrowedGroups(text) {
  const named = new Set(namedCountries(text));
  return groupsIn(text).filter((g) => membersOf(g).some((code) => named.has(code))).map((g) => `${g} narrowed to ${membersOf(g).filter((c) => named.has(c)).map((c) => countryByCode(c).name).join(', ')}, the members you named`);
}

export function buildBrief({ question = '', acceptance = {}, constraints = {}, template = null } = {}) {
  const words = [question, acceptance?.expected, ...Object.values(constraints ?? {})].filter((v) => typeof v === 'string').join(' ');
  const regions = regionsIn(words);
  const groups = openGroups(words);
  const lists = Boolean(acceptance?.itemCount);
  return {
    kind: lists ? template?.itemKind ?? null : null,
    itemCount: acceptance?.itemCount ?? null,
    valueRange: acceptance?.valueRange ?? null,
    unit: acceptance?.unit ?? '',
    regions,
    groups,
    narrowed: narrowedGroups(words),
    coastal: COAST.test(plain(words)),
    excludes: lists ? ['offered for rent', 'offered as a swap', 'news, blog or guide pages', 'search or category pages'] : [],
  };
}

export function describeBrief(brief) {
  if (!brief) return '';
  const grouped = new Set((brief.groups ?? []).flatMap((g) => COUNTRIES.filter((row) => row[3] === g).map(([code]) => code)));
  const names = [...(brief.groups ?? []).map((g) => `${g} (${COUNTRIES.filter((row) => row[3] === g).length} countries)`), ...brief.regions.filter((c) => !grouped.has(c)).map((c) => countryByCode(c)?.name)];
  const where = names.length ? names.join(', ') : 'any country';
  const lines = [
    brief.kind ? `Deliver: ${brief.itemCount ?? 'a list of'} single ${brief.kind.label} listing pages for sale` : 'Deliver: a decision memo',
    brief.valueRange ? `Hard limit: price ${brief.valueRange[0]}–${brief.valueRange[1]} ${brief.unit}`.trim() : '',
    `Where: ${where}${brief.coastal ? ' (near the sea)' : ''}${brief.narrowed?.length ? ` · ${brief.narrowed.join('; ')}` : ''}`,
    brief.excludes.length ? `Exclude: ${brief.excludes.join('; ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function tldCountry(url) {
  try {
    const tld = new URL(url).hostname.split('.').pop().toLowerCase();
    if (GENERIC_TLDS.has(tld)) return '';
    return /^[a-z]{2}$/.test(tld) ? TLD_ALIASES[tld] ?? tld.toUpperCase() : '';
  } catch {
    return '';
  }
}

function textCountries(text) {
  const t = plain(text);
  return COUNTRIES.filter(([code]) => namesOf(code).some((w) => mentions(t, w))).map(([code]) => code);
}

function decodedUrl(url) {
  try {
    return decodeURIComponent(String(url ?? '')).replace(/[-_+/]/g, ' ');
  } catch {
    return String(url ?? '').replace(/[-_+/]/g, ' ');
  }
}

export function localeCountry(locale) {
  const [, language = '', region = ''] = String(locale ?? '').match(/^([a-z]{2,3})(?:[-_]([A-Za-z]{2}))?$/i) ?? [];
  const code = region ? region.toUpperCase() : ONE_COUNTRY_LANGUAGES[language.toLowerCase()] ?? '';
  return countryByCode(code) ? code : '';
}

export function sourceCountry(source) {
  if (!source) return '';
  const byTld = tldCountry(source.url);
  if (byTld) return byTld;
  const byLocale = localeCountry(source.locale);
  if (byLocale) return byLocale;
  const inPath = textCountries(decodedUrl(source.url));
  if (inPath.length === 1) return inPath[0];
  const t = plain(source.text ?? '');
  const counted = COUNTRIES.map(([code]) => [code, namesOf(code).reduce((n, w) => n + countMentions(t, w), 0)]).filter(([, n]) => n >= MIN_TEXT_MENTIONS).sort((a, b) => b[1] - a[1]);
  return counted[0]?.[0] ?? '';
}

export function itemCountry(item, source = null) {
  const byTld = tldCountry(item.url);
  if (byTld) return { code: byTld, by: 'site address' };
  const named = textCountries(`${item.title ?? ''} ${item.place ?? ''} ${decodedUrl(item.url)}`);
  if (named.length === 1) return { code: named[0], by: 'listing text' };
  const fromSource = sourceCountry(source);
  if (fromSource) return { code: fromSource, by: 'source page' };
  return { code: named[0] ?? '', by: named.length ? 'listing text' : '' };
}

export function isNewsPage(url) {
  try {
    return NEWS_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function mentionsCoast(item) {
  return COAST_ON_PAGE.test(plain(`${item.title ?? ''} ${item.place ?? ''} ${item.card ?? ''} ${decodedUrl(item.url)}`));
}

export function hostCountries(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  return COUNTRIES.filter(([code]) => namesOf(code).some((w) => /^[a-z]{5,}$/.test(plain(w)) && host.includes(plain(w)))).map(([code]) => code);
}

export function onConcept(source, brief) {
  if (!brief?.kind || !brief?.regions?.length || source?.kind === 'data' || !source?.url) return true;
  const named = textCountries(`${source.title ?? ''} ${source.snippet ?? ''} ${(source.text ?? '').slice(0, 3000)} ${decodedUrl(source.url)}`);
  return [tldCountry(source.url), localeCountry(source.locale), ...hostCountries(source.url), ...named].some((code) => code && brief.regions.includes(code));
}
