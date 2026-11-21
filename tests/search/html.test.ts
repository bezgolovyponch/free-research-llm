import { describe, expect, it } from 'vitest';
import { absoluteUrl, decodeText, domainOf } from '../../src/search/html.mjs';

describe('html helpers', () => {
  it('resolves links against the page, drops fragments and non-web schemes', () => {
    expect(absoluteUrl('/a?b=1&amp;c=2#x', 'https://site.example/p/q')).toBe('https://site.example/a?b=1&c=2');
    expect(absoluteUrl('mailto:x@site.example', 'https://site.example/')).toBe('');
    expect(domainOf('https://www.site.example/x')).toBe('site.example');
    expect(domainOf('not a url')).toBe('');
  });
});

describe('decodeText', () => {
  it('decodes JSON escapes: \\uXXXX, \\/ and \\"', () => {
    expect(decodeText('+33 2')).toBe('+33 2');
    expect(decodeText('\\u002B33 2')).toBe('+33 2');
    expect(decodeText('https:\\/\\/x.example\\/a.jpg')).toBe('https://x.example/a.jpg');
    expect(decodeText('say "hi"')).toBe('say "hi"');
    expect(decodeText('say \\"hi\\"')).toBe('say "hi"');
  });

  it('decodes named, decimal and hex entities', () => {
    expect(decodeText('&euro; 12')).toBe('&euro; 12');
    expect(decodeText('&#8364; 12')).toBe('€ 12');
    expect(decodeText('&#43;31 85')).toBe('+31 85');
    expect(decodeText('&#x2B;31')).toBe('+31');
    expect(decodeText('&#X2b;31')).toBe('+31');
    expect(decodeText('a&b')).toBe('a&b');
    expect(decodeText('<>"&apos;')).toBe('<>"\'');
    expect(decodeText('&nbsp;x')).toBe(' x');
  });

  it('decodes entities in one pass', () => {
    expect(decodeText('&euro;')).toBe('&euro;');
    expect(decodeText('&#43;')).toBe('+');
    expect(decodeText('&amp;')).toBe('&');
    expect(decodeText('&lt;&gt;&quot;')).toBe('<>"');
    expect(decodeText('&amp;#43;')).toBe('&#43;');
    expect(decodeText('&amp;euro;')).toBe('&euro;');
  });

  it('leaves unknown entities as written', () => {
    expect(decodeText('&foo;')).toBe('&foo;');
    expect(decodeText('&constructor;')).toBe('&constructor;');
    expect(decodeText('&#x110000;')).toBe('&#x110000;');
  });

  it('returns an empty string for null and undefined', () => {
    expect(decodeText(null)).toBe('');
    expect(decodeText(undefined)).toBe('');
  });
});

describe('withTableHeaders pairs each cell with its column (FRL_TABLE_HEADERS)', () => {
  const kosmos = '<table border="1"><tbody><tr><td colspan="4"><h3>KOSMOS-ABO (Unbegrenzte Eintritte)</h3></td></tr><tr><th>&nbsp;</th><th><strong>Normal</strong></th><th><strong>Ermäßigt<sup>1</sup></strong></th><th><strong>Kinder (6-11)</strong></th></tr><tr><th>Monatliche zahlung<br>(6 Monate mindestlaufzeit)<sup>5</sup></th><th><strong>55 Euro</strong></th><th><strong>45 Euro</strong></th><th><strong>30 Euro</strong></th></tr></tbody></table>';

  it('reads a price table as row label, then each column header with its value', async () => {
    const { htmlToText, withTableHeaders } = await import('../../src/search/html.mjs');
    expect(htmlToText(kosmos)).not.toContain('Normal 55 Euro');
    const text = htmlToText(withTableHeaders(`<p>Preise</p>${kosmos}<p>Weiter</p>`));
    expect(text.split('\n').map((line) => line.trim())).toEqual(['Preise', 'KOSMOS-ABO (Unbegrenzte Eintritte)', 'Normal | Ermäßigt 1 | Kinder (6-11)', 'Monatliche zahlung (6 Monate mindestlaufzeit) 5: Normal 55 Euro; Ermäßigt 1 45 Euro; Kinder (6-11) 30 Euro', 'Weiter']);
  });

  it('pairs by header when the first column has a heading too, and starts a new section after a one-cell row', async () => {
    const { tableLines } = await import('../../src/search/html.mjs');
    const table = '<tr><th>Tarif</th><th>Preis</th></tr><tr><td>Tageskarte</td><td>14 Euro</td></tr><tr><td colspan="2">Kurse</td></tr><tr><th>Kurs</th><th>Dauer</th></tr><tr><td>Einsteiger</td><td>2 Stunden</td></tr>';
    expect(tableLines(table)).toBe('Tarif | Preis\nTarif Tageskarte; Preis 14 Euro\nKurse\nKurs | Dauer\nKurs Einsteiger; Dauer 2 Stunden');
  });

  it('keeps rows that do not fit the header, and leaves nested or very large tables as they are', async () => {
    const { tableLines, withTableHeaders, TABLE_MAX_ROWS } = await import('../../src/search/html.mjs');
    expect(tableLines('<tr><th></th><th>A</th><th>B</th></tr><tr><td>x</td><td>1</td></tr>')).toBe('A | B\nx | 1');
    const nested = '<table><tr><td><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>';
    expect(withTableHeaders(nested)).toContain('<table><tr><td><table>');
    const big = `<table>${'<tr><td>a</td><td>b</td></tr>'.repeat(TABLE_MAX_ROWS + 1)}</table>`;
    expect(withTableHeaders(big)).toBe(big);
    expect(withTableHeaders('<table><tr><td>x &lt; y</td><td>z</td></tr><tr><td>1</td><td>2</td></tr></table>')).toContain('x &lt; y');
  });
});
