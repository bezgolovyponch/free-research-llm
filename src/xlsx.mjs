import { crc32, deflateRawSync } from 'node:zlib';

export const MAX_CELL_CHARS = 32767;
export const MAX_SHEET_NAME = 31;
export const MAX_COLUMN_WIDTH = 60;
export const MAX_HYPERLINK_CHARS = 2079;
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = `${NS_REL}`;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const HEADER_STYLE = 1;
const LINK_STYLE = 2;
const DATE_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 24 * 3600 * 1000;

export function xmlText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function sheetName(name, taken = new Set()) {
  const base = String(name ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, MAX_SHEET_NAME) || 'Sheet';
  let candidate = base;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base.slice(0, MAX_SHEET_NAME - String(i).length - 1)} ${i}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function isLink(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value) && value.length <= MAX_HYPERLINK_CHARS;
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"${s}><v>${value ? 1 : 0}</v></c>`;
  if (value instanceof Date && Number.isFinite(value.getTime())) return `<c r="${ref}" s="3"><v>${(value.getTime() - DATE_EPOCH_MS) / DAY_MS}</v></c>`;
  const text = String(value ?? '');
  if (!text) return '';
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlText(text.slice(0, MAX_CELL_CHARS))}</t></is></c>`;
}

function widthOf(rows, col) {
  const longest = rows.reduce((max, row) => Math.max(max, String(row[col] ?? '').length), 0);
  return Math.min(MAX_COLUMN_WIDTH, Math.max(8, longest + 2));
}

export function sheetXml(rows) {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const links = [];
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const link = r > 0 && isLink(value);
      if (link) links.push({ ref, url: value });
      return cellXml(ref, value, r === 0 ? HEADER_STYLE : link ? LINK_STYLE : 0);
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const cols = columns ? `<cols>${Array.from({ length: columns }, (_, c) => `<col min="${c + 1}" max="${c + 1}" width="${widthOf(rows, c)}" customWidth="1"/>`).join('')}</cols>` : '';
  const pane = rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  const filter = rows.length > 1 && columns ? `<autoFilter ref="A1:${columnName(columns - 1)}${rows.length}"/>` : '';
  const hyperlinks = links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '';
  const xml = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${pane}${cols}<sheetData>${body}</sheetData>${filter}${hyperlinks}</worksheet>`;
  const rels = links.length ? `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/hyperlink" Target="${xmlText(l.url)}" TargetMode="External"/>`).join('')}</Relationships>` : null;
  return { xml, rels, links: links.length };
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function workbookFiles(sheets) {
  const taken = new Set();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken), rows: s.rows ?? [] }));
  const files = [];
  const built = named.map((s) => sheetXml(s.rows));
  files.push(['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`]);
  files.push(['_rels/.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  files.push(['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${named.some((s) => s.rows.length > 1) ? `<definedNames>${named.map((s, i) => (s.rows.length > 1 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(s.name.replace(/'/g, "''"))}'!$A$1:$${columnName(Math.max(0, s.rows.reduce((m, r) => Math.max(m, r.length), 0) - 1))}$${s.rows.length}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${named.length + 1}" Type="${REL_TYPE}/styles" Target="styles.xml"/></Relationships>`]);
  files.push(['xl/styles.xml', STYLES]);
  built.forEach((b, i) => {
    files.push([`xl/worksheets/sheet${i + 1}.xml`, b.xml]);
    if (b.rels) files.push([`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, b.rels]);
  });
  return files;
}

function dosTime(date) {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

export function zip(files, date = new Date()) {
  const { time, day } = dosTime(date);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function workbook(sheets, date = new Date()) {
  return zip(workbookFiles(sheets), date);
}
