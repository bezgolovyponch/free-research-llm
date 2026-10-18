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

  it('uses the right key store per platform and nothing on unknown platforms', async () => {
    const calls: Array<[string, string[], unknown]> = [];
    const run = async (cmd: string, args: string[], opts?: unknown) => {
      calls.push([cmd, args, opts]);
      return { stdout: cmd === 'reg' ? '    GROQ_API_KEY    REG_SZ    gsk_win\r\n' : 'value\n' };
    };
    expect(await new KeychainSecrets({ platform: 'linux', run }).read('GROQ_API_KEY')).toBe('value');
    await new KeychainSecrets({ platform: 'linux', run }).write('GROQ_API_KEY', 'gsk_x');
    expect(calls.at(-1)).toEqual(['secret-tool', ['store', '--label', 'free-research-llm GROQ_API_KEY', 'service', 'free-research-llm', 'account', 'GROQ_API_KEY'], { input: 'gsk_x' }]);
    expect(await new KeychainSecrets({ platform: 'win32', run }).read('GROQ_API_KEY')).toBe('gsk_win');
    await new KeychainSecrets({ platform: 'win32', run }).write('GROQ_API_KEY', 'gsk_y');
    expect(calls.at(-1)).toEqual(['setx', ['GROQ_API_KEY', 'gsk_y'], undefined]);
    expect(await new KeychainSecrets({ platform: 'aix', run }).fillMissing({})).toEqual([]);
    expect(new KeychainSecrets({ platform: 'darwin', run }).label).toBe('macOS Keychain');
    expect(secretNames()).toEqual(expect.arrayContaining(['GEMINI_API_KEY', 'MISTRAL_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'PUTER_AUTH_TOKEN', 'TAVILY_API_KEY', 'SERPER_API_KEY']));
  });
});

describe('KeychainSecrets.refresh', () => {
  it('updates and removes keys it loaded, and never overrides keys set in the shell', async () => {
    const { KeychainSecrets } = await import('../src/secrets.mjs');
    const store: Record<string, string> = { GROQ_API_KEY: 'g1', TAVILY_API_KEY: 't1' };
    const run = async (_cmd: string, args: string[]) => {
      const name = args[args.indexOf('-a') + 1];
      if (!store[name]) throw new Error('not found');
      return { stdout: `${store[name]}\n` };
    };
    const secrets = new KeychainSecrets({ platform: 'darwin', run });
    const env: Record<string, string> = { CEREBRAS_API_KEY: 'from-shell' };
    await secrets.fillMissing(env, ['GROQ_API_KEY', 'TAVILY_API_KEY', 'CEREBRAS_API_KEY']);
    store.GROQ_API_KEY = 'g2';
    delete store.TAVILY_API_KEY;
    store.CEREBRAS_API_KEY = 'keychain';
    expect(await secrets.refresh(env, ['GROQ_API_KEY', 'TAVILY_API_KEY', 'CEREBRAS_API_KEY'])).toEqual(['GROQ_API_KEY', 'TAVILY_API_KEY']);
    expect(env).toEqual({ CEREBRAS_API_KEY: 'from-shell', GROQ_API_KEY: 'g2' });
  });
});

