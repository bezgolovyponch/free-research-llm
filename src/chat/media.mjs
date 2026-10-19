import { describeProfile, parseCsv, profileTable } from '../data/csv.mjs';
import { htmlToText } from '../search/search.mjs';
import { TASK_MARKERS } from '../research/prompts.mjs';

export const MAX_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_FILES = 4;
export const FILE_TEXT_LIMIT = 12000;

const KINDS = [
  ['table', /\.(csv|tsv)$/i, 'text/csv'],
  ['html', /\.html?$/i, 'text/html'],
  ['text', /\.(txt|md|markdown|json|xml|log|yaml|yml|ini|js|mjs|ts|py|sql)$/i, 'text/plain'],
  ['image', /\.(png|jpe?g|webp|gif|heic|heif)$/i, null],
  ['pdf', /\.pdf$/i, 'application/pdf'],
  ['audio', /\.(mp3|wav)$/i, null],
];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };

const READ_INSTRUCTION = `${TASK_MARKERS.readFile}
Read this file for a research app. Write plain text, no JSON:
1. What it is (one line).
2. Every piece of text, number, price, date, name, link and table cell you can read, exactly as written (tables as "col | col" rows).
3. Anything visible that matters for a decision (charts, photos: what they show).
Do not guess what you cannot read; write [unreadable] instead.`;

export class UnsupportedFileError extends Error {}

export function fileKind(name, type = '') {
  const hit = KINDS.find(([, pattern]) => pattern.test(name));
  if (hit) return hit[0];
  if (/^image\//.test(type)) return 'image';
  if (/^audio\/(mpeg|wav|x-wav)/.test(type)) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (/^text\//.test(type)) return 'text';
  return null;
}

function mimeOf(name, type) {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME[ext] ?? (type || 'application/octet-stream');
}

export function decodeBase64(data) {
  return Buffer.from(String(data ?? '').replace(/^data:[^,]*,/, ''), 'base64');
}

export class MediaReader {
  constructor({ router }) {
    this.router = router;
  }

  modelPart(kind, name, type, base64) {
    if (kind === 'audio') return { type: 'input_audio', input_audio: { data: base64, format: /\.wav$/i.test(name) ? 'wav' : 'mp3' } };
    return { type: 'image_url', image_url: { url: `data:${mimeOf(name, type)};base64,${base64}` } };
  }

  async read({ name = '', type = '', data = '' } = {}) {
    const fileName = String(name).trim().slice(0, 120) || 'file';
    const kind = fileKind(fileName, type);
    if (!kind) throw new UnsupportedFileError(`${fileName}: this file type cannot be read. Use a photo, screenshot, PDF, MP3/WAV, CSV, TXT, MD, JSON or HTML (export Word/Excel files as PDF or CSV)`);
    const bytes = decodeBase64(data);
    if (!bytes.length) throw new UnsupportedFileError(`${fileName}: the file is empty`);
    if (bytes.length > MAX_FILE_BYTES) throw new UnsupportedFileError(`${fileName}: too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
    let text;
    let model = '';
    if (kind === 'table') text = describeProfile(profileTable(parseCsv(bytes.toString('utf8'))), fileName);
    else if (kind === 'html') text = htmlToText(bytes.toString('utf8'));
    else if (kind === 'text') text = bytes.toString('utf8');
    else {
      const reply = await this.router.complete({ purpose: 'read-file', tier: 'vision', json: false, messages: [{ role: 'user', content: [{ type: 'text', text: READ_INSTRUCTION }, this.modelPart(kind, fileName, type, bytes.toString('base64'))] }] });
      text = String(reply.content ?? '').trim();
      model = `${reply.provider}/${reply.model}`;
    }
    return { name: fileName, kind, size: bytes.length, text: text.slice(0, FILE_TEXT_LIMIT), truncated: text.length > FILE_TEXT_LIMIT, model, readAt: new Date().toISOString() };
  }

  async readAll(files = []) {
    const list = Array.isArray(files) ? files.slice(0, MAX_FILES) : [];
    const read = [];
    for (const file of list) read.push(await this.read(file));
    return read;
  }
}

export function filesBlock(files = []) {
  if (!files.length) return '';
  return `FILES THE USER ATTACHED (read by the app${files.some((f) => f.model) ? "; photos, PDFs and audio were read by a model, so treat them as the user's evidence, not as checked facts" : ''}):\n${files.map((f, i) => `[F${i + 1}] ${f.name} (${f.kind}${f.model ? `, read by ${f.model}` : ''}${f.truncated ? ', cut' : ''}):\n${f.text}`).join('\n\n')}\n`;
}
