import { describe, expect, it } from 'vitest';
import { SPEED_BUDGET_S, measureSpeed, projectedSeconds, speedVerdict } from '../../src/local/speed.mjs';

describe('local model speed gate', () => {
  it('accepts the Mac llama.cpp speed and refuses the CPU-bound PC speed measured on 2026-10-23', () => {
    expect(speedVerdict({ prefill: 102, decode: 19.2 })).toMatchObject({ usable: true });
    const pc = speedVerdict({ prefill: 12, decode: 2.1 });
    expect(pc.usable).toBe(false);
    expect(pc.text).toMatch(/too slow for research \(reads 12 tokens\/s, writes 2\.1 tokens\/s: a typical 7000-token research call takes 774 s; even a short 1500-token call takes 173 s, the limit is 100 s\)/);
    expect(speedVerdict({ prefill: 102, decode: 19.2 }).text).toMatch(/it gets the calls that fit its speed/);
    expect(projectedSeconds({ prefill: 0, decode: 5 })).toBe(Infinity);
    expect(SPEED_BUDGET_S).toBe(100);
  });

  it('reads llama.cpp timings, and falls back to token counts over wall time for servers without them', async () => {
    const bodies: string[] = [];
    const llama = (async (_u: string, init: { body: string }) => { bodies.push(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }], timings: { prompt_n: 1480, prompt_per_second: 80, predicted_per_second: 15 } })); }) as never;
    expect(await measureSpeed('http://pc:8090/v1', { fetchImpl: llama })).toEqual({ prefill: 80, decode: 15 });
    await measureSpeed('http://pc:8090/v1', { fetchImpl: llama });
    expect(JSON.parse(bodies[0]).cache_prompt).toBe(false);
    expect(JSON.parse(bodies[0]).messages[0].content).not.toBe(JSON.parse(bodies[1]).messages[0].content);
    const cached = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }], timings: { prompt_n: 3, prompt_per_second: 0.4, predicted_per_second: 22 }, usage: { prompt_tokens: 1500, completion_tokens: 24 } }))) as never;
    expect((await measureSpeed('http://mac:8090/v1', { fetchImpl: cached })).prefill).toBeGreaterThan(100);
    const ollama = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1500, completion_tokens: 24 } }))) as never;
    const speed = await measureSpeed('http://pc:11434/v1/', { fetchImpl: ollama });
    expect(speed.prefill).toBeGreaterThan(1000);
    await expect(measureSpeed('http://pc:8090/v1', { fetchImpl: (async () => new Response('no', { status: 503 })) as never })).rejects.toThrow('HTTP 503');
  });
});
