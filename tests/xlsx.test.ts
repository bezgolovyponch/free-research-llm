import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_CELL_CHARS, columnName, isLink, sheetName, sheetXml, workbook, xmlText, zip } from '../src/xlsx.mjs';
import { unzip } from './helpers/unzip';

describe('xlsx writer: a workbook Excel and Google Sheets open, with no dependency', () => {
  it('names columns past Z and keeps sheet names legal and unique', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    const taken = new Set<string>();
    expect(sheetName('Plots [all]: 2026/10', taken)).toBe('Plots  all   2026 10');
    expect(sheetName('plots  all   2026 10', taken)).toBe('plots  all   2026 10 2');
    expect(sheetName('x'.repeat(40), new Set()).length).toBe(31);
  });

  it('escapes XML and drops characters XML cannot hold', () => {
    expect(xmlText('a & <b> "c"\u0001')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });

  it('writes numbers as numbers, links as clickable hyperlinks, a bold frozen header and a filter on every column', () => {
    const { xml, rels, links } = sheetXml([['title', 'price', 'url'], ['Terreno & mar', -3.5, 'https://x.example/a?b=1&c=2'], ['plain', 2, 'not a link']]);
    expect(xml).toContain('<c r="B2"><v>-3.5</v></c>');
    expect(xml).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(xml).toContain('<autoFilter ref="A1:C3"/>');
    expect(xml).toContain('<hyperlink ref="C2" r:id="rId1"/>');
    expect(links).toBe(1);
    expect(rels).toContain('Target="https://x.example/a?b=1&amp;c=2" TargetMode="External"');
    expect(isLink('https://a.example/x y')).toBe(false);
  });

  it('cuts a cell at the Excel limit instead of producing a file Excel refuses', () => {
    const { xml } = sheetXml([['a'], ['x'.repeat(MAX_CELL_CHARS + 10)]]);
    expect(xml.match(/>(x+)</)![1].length).toBe(MAX_CELL_CHARS);
  });

  it('packs a valid zip: every entry inflates to its content and matches its CRC', () => {
    const buffer = zip([['a.txt', 'hello'], ['b/c.xml', '<x/>']]);
    const files = unzip(buffer);
    expect(files).toEqual({ 'a.txt': 'hello', 'b/c.xml': '<x/>' });
    expect(buffer.readUInt32LE(14)).toBe(crc32(Buffer.from('hello')));
    expect(inflateRawSync(buffer.subarray(30 + 5, 30 + 5 + buffer.readUInt32LE(18))).toString()).toBe('hello');
  });

  it('holds the parts a spreadsheet needs: content types, workbook, styles and one sheet per table', () => {
    const files = unzip(workbook([{ name: 'Summary', rows: [['field', 'value'], ['q', 'x']] }, { name: 'Listings', rows: [['url'], ['https://a.example/1']] }], new Date(Date.UTC(2026, 9, 27))));
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/_rels/sheet2.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    expect(files['xl/workbook.xml']).toContain('<sheet name="Listings" sheetId="2" r:id="rId2"/>');
    expect(files['xl/workbook.xml']).toContain("'Listings'!$A$1:$A$2");
    expect(files['[Content_Types].xml']).toContain('/xl/worksheets/sheet2.xml');
    expect(files['xl/styles.xml']).toContain('<cellStyle name="Normal" xfId="0" builtinId="0"/>');
  });
});
