import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PDF_MAX_BYTES = 15 * 1024 * 1024;
export const PDF_TIMEOUT_MS = 20000;

export function pdfReaderOn(env = process.env) {
  return Boolean(env.FRL_READ_PDF);
}

export function pdftotextPath(env = process.env) {
  return String(env.FRL_PDFTOTEXT ?? '').trim() || 'pdftotext';
}

export function mayBePdf(type) {
  return /application\/(pdf|x-pdf|octet-stream)/i.test(String(type ?? ''));
}

export function startsAsPdf(bytes) {
  return Boolean(bytes && bytes.length >= 5) && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

export function pdfArgs(file) {
  return ['-raw', '-enc', 'UTF-8', '-q', file, '-'];
}

export function cleanPdfText(text) {
  return String(text ?? '').replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function pdfText(bytes, { env = process.env, run = execFile } = {}) {
  if (!startsAsPdf(bytes) || bytes.length > PDF_MAX_BYTES) return '';
  let dir = '';
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'frl-pdf-'));
    const file = path.join(dir, 'page.pdf');
    await writeFile(file, bytes);
    const out = await new Promise((resolve) => {
      run(pdftotextPath(env), pdfArgs(file), { timeout: PDF_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout ?? '')));
    });
    return cleanPdfText(out);
  } catch {
    return '';
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
