import { describe, expect, it } from 'vitest';
import { MediaReader, UnsupportedFileError, fileKind, filesBlock } from '../../src/chat/media.mjs';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function fakeRouter() {
  const calls: Array<{ tier: string; json: boolean; messages: Array<{ content: Array<Record<string, unknown>> }> }> = [];
  return {
    calls,
    complete: async (req: { tier: string; json: boolean; messages: Array<{ content: Array<Record<string, unknown>> }> }) => {
      calls.push(req);
      return { content: 'Invoice 4711. Total: 2,345 EUR', provider: 'gemini', model: 'gemini-3.5-flash-lite' };
    },
  };
}

describe('MediaReader', () => {
  it('reads text, tables and HTML in code, without a model', async () => {
    const router = fakeRouter();
    const reader = new MediaReader({ router });
    expect((await reader.read({ name: 'notes.md', data: b64('# Golf\nprice 2000') })).text).toContain('price 2000');
    const table = await reader.read({ name: 'cars.csv', data: b64('make,price\nVW,2000\nFord,2500\n') });
    expect(table).toMatchObject({ kind: 'table', model: '' });
    expect(table.text).toContain('price');
    expect((await reader.read({ name: 'p.html', data: b64('<p>Hello <b>world</b></p>') })).text).toContain('Hello world');
    expect(router.calls).toHaveLength(0);
  });

  it('sends photos and PDFs to a vision model and audio as input_audio', async () => {
    const router = fakeRouter();
    const reader = new MediaReader({ router });
    const photo = await reader.read({ name: 'shot.JPG', type: 'image/jpeg', data: `data:image/jpeg;base64,${b64('jpegbytes')}` });
    expect(photo).toMatchObject({ kind: 'image', model: 'gemini/gemini-3.5-flash-lite', text: 'Invoice 4711. Total: 2,345 EUR' });
    expect(router.calls[0]).toMatchObject({ tier: 'vision', json: false });
    expect(router.calls[0].messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64('jpegbytes')}` } });
    await reader.read({ name: 'invoice.pdf', data: b64('%PDF-1.4') });
    expect(JSON.stringify(router.calls[1].messages[0].content[1])).toContain('data:application/pdf;base64');
    await reader.read({ name: 'memo.wav', data: b64('RIFF') });
    expect(router.calls[2].messages[0].content[1]).toEqual({ type: 'input_audio', input_audio: { data: b64('RIFF'), format: 'wav' } });
  });

  it('refuses unknown, empty and oversized files with a clear reason', async () => {
    const reader = new MediaReader({ router: fakeRouter() });
    await expect(reader.read({ name: 'a.docx', data: b64('x') })).rejects.toThrow(UnsupportedFileError);
    await expect(reader.read({ name: 'a.txt', data: '' })).rejects.toThrow(/empty/);
    await expect(reader.read({ name: 'a.txt', data: Buffer.alloc(7 * 1024 * 1024).toString('base64') })).rejects.toThrow(/too large/);
    expect(fileKind('x.bin', 'image/png')).toBe('image');
    expect(fileKind('x.bin', '')).toBeNull();
  });

  it('describes attached files for the prompt and marks model readings', () => {
    expect(filesBlock([])).toBe('');
    const block = filesBlock([{ name: 'shot.jpg', kind: 'image', text: 'Total 5', model: 'gemini/x', truncated: false }]);
    expect(block).toContain('[F1] shot.jpg (image, read by gemini/x)');
    expect(block).toContain('not as checked facts');
  });
});
