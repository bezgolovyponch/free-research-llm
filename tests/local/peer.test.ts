import { describe, expect, it } from 'vitest';
import { peerHost, probePeer } from '../../src/local/peer.mjs';

describe('peerHost', () => {
  it('accepts an address with or without scheme and port, refuses junk', () => {
    expect(peerHost('192.168.5.26')).toBe('192.168.5.26');
    expect(peerHost('http://192.168.5.26:11434/v1')).toBe('192.168.5.26');
    expect(peerHost('gaming-pc.local')).toBe('gaming-pc.local');
    expect(() => peerHost('')).toThrow(/Wi-Fi address/);
    expect(() => peerHost('rm -rf /')).toThrow(/Wi-Fi address/);
  });
});

describe('probePeer', () => {
  it('finds Ollama and llama.cpp on the other PC and says why one is missing', async () => {
    const fetchImpl = async (url: string) => {
      if (url === 'http://192.168.5.26:11434/v1/models') return new Response(JSON.stringify({ data: [{ id: 'qwen3:14b' }] }));
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    const found = await probePeer('192.168.5.26', { fetchImpl: fetchImpl as never });
    expect(found.map((f) => [f.id, f.ok, f.url])).toEqual([['ollama', true, 'http://192.168.5.26:11434/v1'], ['llamacpp-lan', false, 'http://192.168.5.26:8090/v1']]);
    expect(found[0].models).toEqual(['qwen3:14b']);
    expect(found[1].detail).toMatch(/Windows Firewall/);
  });

  it('reports a running server with no model', async () => {
    const found = await probePeer('10.0.0.5', { fetchImpl: (async () => new Response(JSON.stringify({ data: [] }))) as never });
    expect(found.every((f) => !f.ok && /no model/.test(f.detail))).toBe(true);
  });
});
