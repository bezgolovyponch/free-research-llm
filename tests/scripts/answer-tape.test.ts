import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnswerTape, tapeKey, tapeSummary } from '../../scripts/answer-tape.mjs';

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const URL_A = 'https://api.example.test/v1/chat?key=secret';
const BODY = JSON.stringify({ prompt: 'one', n: 2 });
const SECRET_INIT = { method: 'POST', body: BODY, headers: { authorization: 'Bearer SECRETTOKEN', 'x-api-key': 'SECRETKEY' } };

function fake(status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }, text = '{"ok":true}') {
  const calls: unknown[] = [];
  const impl = async (input: unknown) => {
    calls.push(input);
    return new Response(text, { status, headers });
  };
  return { impl, calls };
}

function storedFiles(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((sub) => fs.readdirSync(path.join(dir, sub)).map((name) => path.join(dir, sub, name)));
}

describe('answer tape', () => {
  it('keys are stable across JSON whitespace and query strings and differ by body', () => {
    const spaced = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(tapeKey(URL_A, spaced)).toBe(tapeKey('https://api.example.test/v1/chat', BODY));
    expect(tapeKey(URL_A, BODY)).not.toBe(tapeKey(URL_A, JSON.stringify({ prompt: 'two', n: 2 })));
    expect(tapeKey(URL_A, 'plain text')).toBe(tapeKey(URL_A, 'plain text'));
    expect(tapeKey(URL_A, BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records then replays identical status, body and content-type with zero network calls', async () => {
    const dir = tmp();
    const recorder = fake(200, { 'content-type': 'application/json' }, '{"answer":42}');
    const record = createAnswerTape({ dir, mode: 'record', fetchImpl: recorder.impl });
    const first = await record.fetch(URL_A, SECRET_INIT);
    expect(await first.json()).toEqual({ answer: 42 });
    expect(record.stats).toEqual({ hits: 0, misses: 0, recorded: 1, blocked: 0 });
    const offline = fake();
    const replay = createAnswerTape({ dir, mode: 'replay', fetchImpl: offline.impl });
    const second = await replay.fetch(URL_A, { ...SECRET_INIT, body: JSON.stringify(JSON.parse(BODY), null, 4) });
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toBe('application/json');
    expect(await second.text()).toBe('{"answer":42}');
    expect(offline.calls).toHaveLength(0);
    expect(replay.stats.hits).toBe(1);
  });

  it('records error answers with retry-after and replays them', async () => {
    const dir = tmp();
    const limited = fake(429, { 'content-type': 'text/plain', 'retry-after': '7' }, 'slow down');
    await createAnswerTape({ dir, mode: 'record', fetchImpl: limited.impl }).fetch(URL_A, SECRET_INIT);
    const replay = createAnswerTape({ dir, mode: 'replay', fetchImpl: fake().impl });
    const response = await replay.fetch(URL_A, SECRET_INIT);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.text()).toBe('slow down');
  });

  it('does not record a thrown fetch error', async () => {
    const dir = tmp();
    const tape = createAnswerTape({
      dir,
      mode: 'auto',
      fetchImpl: async () => {
        throw new Error('timeout');
      },
    });
    await expect(tape.fetch(URL_A, SECRET_INIT)).rejects.toThrow('timeout');
    expect(tape.stats.recorded).toBe(0);
    expect(await tapeSummary(dir)).toEqual({ answers: 0, statuses: {} });
  });

  it('replay miss throws "not on tape" naming key and url, never calling fetchImpl', async () => {
    const offline = fake();
    const tape = createAnswerTape({ dir: tmp(), mode: 'replay', fetchImpl: offline.impl });
    await expect(tape.fetch(URL_A, SECRET_INIT)).rejects.toThrow(`not on tape: ${tapeKey(URL_A, BODY)} https://api.example.test/v1/chat`);
    expect(offline.calls).toHaveLength(0);
    expect(tape.stats).toMatchObject({ misses: 1, blocked: 1 });
  });

  it('replay refuses GET and bodiless POST, but auto passes them through unrecorded', async () => {
    const offline = fake();
    const replay = createAnswerTape({ dir: tmp(), mode: 'replay', fetchImpl: offline.impl });
    await expect(replay.fetch('https://x.test/page')).rejects.toThrow('network off in replay');
    await expect(replay.fetch('https://x.test/page', { method: 'POST' })).rejects.toThrow('network off in replay');
    expect(offline.calls).toHaveLength(0);
    expect(replay.stats.blocked).toBe(2);
    const dir = tmp();
    const live = fake();
    const auto = createAnswerTape({ dir, mode: 'auto', fetchImpl: live.impl });
    expect((await auto.fetch('https://x.test/page')).status).toBe(200);
    expect(live.calls).toHaveLength(1);
    expect(auto.stats.recorded).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reads bases before dir and never writes to them', async () => {
    const base = tmp();
    const dir = tmp();
    const textOf = (text: string) => fake(200, { 'content-type': 'text/plain' }, text).impl;
    await createAnswerTape({ dir: base, mode: 'record', fetchImpl: textOf('from base') }).fetch(URL_A, SECRET_INIT);
    const before = storedFiles(base);
    await createAnswerTape({ dir, mode: 'record', fetchImpl: textOf('from dir') }).fetch(URL_A, SECRET_INIT);
    const offline = fake();
    const tape = createAnswerTape({ dir, bases: [base], mode: 'replay', fetchImpl: offline.impl });
    expect(await (await tape.fetch(URL_A, SECRET_INIT)).text()).toBe('from base');
    const other = { ...SECRET_INIT, body: JSON.stringify({ prompt: 'other' }) };
    const auto = createAnswerTape({ dir, bases: [base], mode: 'auto', fetchImpl: textOf('new') });
    await auto.fetch(URL_A, other);
    expect(storedFiles(base)).toEqual(before);
    expect(storedFiles(dir)).toHaveLength(2);
  });

  it('auto mode records misses and serves hits', async () => {
    const dir = tmp();
    const live = fake(200, { 'content-type': 'application/json' }, '{"n":1}');
    const tape = createAnswerTape({ dir, mode: 'auto', fetchImpl: live.impl });
    await tape.fetch(URL_A, SECRET_INIT);
    await tape.fetch(URL_A, SECRET_INIT);
    expect(live.calls).toHaveLength(1);
    expect(tape.stats).toEqual({ hits: 1, misses: 1, recorded: 1, blocked: 0 });
    expect(await tapeSummary(dir)).toEqual({ answers: 1, statuses: { 200: 1 } });
  });

  it('stores no request header or query string in any file', async () => {
    const dir = tmp();
    await createAnswerTape({ dir, mode: 'record', fetchImpl: fake().impl }).fetch(URL_A, SECRET_INIT);
    const files = storedFiles(dir);
    expect(files).toHaveLength(1);
    const text = fs.readFileSync(files[0], 'utf8');
    for (const secret of ['SECRETTOKEN', 'SECRETKEY', 'authorization', 'x-api-key', 'key=secret']) expect(text).not.toContain(secret);
    expect(JSON.parse(text).url).toBe('https://api.example.test/v1/chat');
  });
});
