import { describe, expect, it } from 'vitest';
import { KEYCHAIN_SERVICE, KeychainSecrets, secretNames } from '../src/secrets.mjs';

describe('KeychainSecrets', () => {
  it('fills only missing variables from the macOS Keychain', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes('GROQ_API_KEY')) return { stdout: 'gsk-from-keychain\n' };
      throw new Error('not found');
    };
    const env: Record<string, string> = { GEMINI_API_KEY: 'from-shell' };
    const loaded = await new KeychainSecrets({ platform: 'darwin', run }).fillMissing(env, ['GEMINI_API_KEY', 'GROQ_API_KEY', 'EXA_API_KEY']);
    expect(loaded).toEqual(['GROQ_API_KEY']);
    expect(env).toEqual({ GEMINI_API_KEY: 'from-shell', GROQ_API_KEY: 'gsk-from-keychain' });
    expect(calls[0]).toEqual(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'GROQ_API_KEY', '-w']);
  });

  it('does nothing off macOS and knows every provider and search key name', async () => {
    expect(await new KeychainSecrets({ platform: 'linux', run: async () => ({ stdout: 'x' }) }).fillMissing({})).toEqual([]);
    expect(secretNames()).toEqual(expect.arrayContaining(['GEMINI_API_KEY', 'MISTRAL_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'PUTER_AUTH_TOKEN', 'TAVILY_API_KEY', 'SERPER_API_KEY']));
  });
});
