import { describe, expect, it } from 'vitest';
import { BundleError, openKeys, sealKeys } from '../src/keybundle.mjs';

describe('key bundle', () => {
  it('round-trips keys with the right passphrase and hides them in transit', () => {
    const bundle = sealKeys({ GROQ_API_KEY: 'gsk_secret', TAVILY_API_KEY: 'tvly-x' }, 'correct horse battery');
    expect(bundle.startsWith('frl1.')).toBe(true);
    expect(bundle).not.toContain('gsk_secret');
    expect(openKeys(`  ${bundle.slice(0, 20)}\n${bundle.slice(20)} `, 'correct horse battery')).toEqual({ GROQ_API_KEY: 'gsk_secret', TAVILY_API_KEY: 'tvly-x' });
  });

  it('rejects a wrong passphrase, a tampered or cut bundle, short passphrases and foreign text', () => {
    const bundle = sealKeys({ GROQ_API_KEY: 'gsk_secret' }, 'correct horse battery');
    expect(() => openKeys(bundle, 'wrong passphrase!')).toThrow(/wrong passphrase/);
    const tampered = bundle.slice(0, -3) + (bundle.endsWith('A') ? 'BBB' : 'AAA');
    expect(() => openKeys(tampered, 'correct horse battery')).toThrow(BundleError);
    expect(() => openKeys(bundle.slice(0, 30), 'correct horse battery')).toThrow(/cut off/);
    expect(() => sealKeys({}, 'short')).toThrow(/at least 10/);
    expect(() => openKeys('hello', 'correct horse battery')).toThrow(/not a free-research-llm key bundle/);
  });
});
