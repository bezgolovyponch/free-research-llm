import { describe, expect, it } from 'vitest';
import { credentialNames, hermeticEnv } from '../../scripts/hermetic-env.mjs';
import config from '../../playwright.config.mjs';

describe('hermetic environment for the e2e server', () => {
  it('blanks every model and search credential the shell may carry, so demo runs never call real services', () => {
    const presets = [{ keyEnv: 'GROQ_API_KEY' }, { keyEnv: 'CLOUDFLARE_API_TOKEN', accountEnv: 'CLOUDFLARE_ACCOUNT_ID' }, { baseEnv: 'LLAMACPP_BASE_URL', keyEnv: null }];
    const search = [{ env: 'BRAVE_API_KEY' }, { env: 'SEARXNG_URL' }];
    expect(credentialNames(presets, search)).toEqual(['BRAVE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'GROQ_API_KEY', 'LLAMACPP_BASE_URL', 'SEARXNG_URL']);
    expect(hermeticEnv({ PORT: '4610' }, presets, search)).toEqual({ BRAVE_API_KEY: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', GROQ_API_KEY: '', LLAMACPP_BASE_URL: '', SEARXNG_URL: '', FRL_KEYCHAIN: '0', FRL_LOCAL_AUTOSTART: '0', PORT: '4610' });
  });

  it('covers the real presets, and the e2e server is started with it', () => {
    const names = credentialNames();
    for (const name of ['GEMINI_API_KEY', 'NVIDIA_API_KEY', 'LANGSEARCH_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SEARXNG_URL', 'LLAMACPP_BASE_URL']) expect(names).toContain(name);
    const env = (config.webServer as { env: Record<string, string> }).env;
    expect(env).toMatchObject({ BRAVE_API_KEY: '', GEMINI_API_KEY: '', SEARXNG_URL: '', FRL_LOCAL_AUTOSTART: '0', FRL_DEMO: '1' });
  });
});
