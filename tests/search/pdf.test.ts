import { describe, expect, it } from 'vitest';
import { cleanPdfText, mayBePdf, pdfArgs, pdfReaderOn, pdfText, pdftotextPath, startsAsPdf, PDF_MAX_BYTES } from '../../src/search/pdf.mjs';

const pdf = (text = 'body') => new TextEncoder().encode(`%PDF-1.7\n${text}`);

describe('PDF detection and settings', () => {
  it('is off without FRL_READ_PDF and finds pdftotext on the PATH unless FRL_PDFTOTEXT names it', () => {
    expect(pdfReaderOn({})).toBe(false);
    expect(pdfReaderOn({ FRL_READ_PDF: '1' })).toBe(true);
    expect(pdftotextPath({})).toBe('pdftotext');
    expect(pdftotextPath({ FRL_PDFTOTEXT: ' C:\\tools\\pdftotext.exe ' })).toBe('C:\\tools\\pdftotext.exe');
  });

  it('takes a PDF by its content type or its first bytes, and nothing else', () => {
    expect(mayBePdf('application/pdf')).toBe(true);
    expect(mayBePdf('application/octet-stream')).toBe(true);
    expect(mayBePdf('text/html; charset=utf-8')).toBe(false);
    expect(startsAsPdf(pdf())).toBe(true);
    expect(startsAsPdf(new TextEncoder().encode('<html>'))).toBe(false);
    expect(startsAsPdf(new Uint8Array())).toBe(false);
  });

  it('keeps table rows whole (raw order), in UTF-8, and cleans page breaks', () => {
    expect(pdfArgs('a.pdf')).toEqual(['-raw', '-enc', 'UTF-8', '-q', 'a.pdf', '-']);
    expect(cleanPdfText('Dodávka 2024  \n\n\n\n2024 23 094 80 1 634 107 24 918\f3\n')).toBe('Dodávka 2024\n\n2024 23 094 80 1 634 107 24 918\n3');
  });
});

describe('pdfText', () => {
  it('runs the converter on the document and returns its cleaned text', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const run = (bin: string, args: string[], _opts: unknown, done: (error: Error | null, stdout: string) => void) => {
      calls.push({ bin, args });
      done(null, 'Rok Celkem\f2024 24 918\n');
    };
    expect(await pdfText(pdf(), { env: { FRL_PDFTOTEXT: 'pdftotext-test' }, run: run as never })).toBe('Rok Celkem\n2024 24 918');
    expect(calls[0].bin).toBe('pdftotext-test');
    expect(calls[0].args.slice(0, 4)).toEqual(['-raw', '-enc', 'UTF-8', '-q']);
    expect(calls[0].args[5]).toBe('-');
  });

  it('returns nothing when the converter is missing or fails, when the bytes are no PDF, or when the document is too large', async () => {
    let ran = 0;
    const failing = (_bin: string, _args: string[], _opts: unknown, done: (error: Error | null, stdout: string) => void) => {
      ran++;
      done(Object.assign(new Error('spawn pdftotext ENOENT'), { code: 'ENOENT' }), '');
    };
    expect(await pdfText(pdf(), { env: {}, run: failing as never })).toBe('');
    expect(ran).toBe(1);
    expect(await pdfText(new TextEncoder().encode('<html>'), { env: {}, run: failing as never })).toBe('');
    const huge = new Uint8Array(PDF_MAX_BYTES + 1);
    huge.set(new TextEncoder().encode('%PDF-'));
    expect(await pdfText(huge, { env: {}, run: failing as never })).toBe('');
    expect(ran).toBe(1);
  });
});
