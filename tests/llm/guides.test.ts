import { describe, expect, it } from 'vitest';
import { GUIDES_CHECKED, KEY_GUIDES, guideFor, guidesFor } from '../../src/llm/guides.mjs';
import { PROVIDER_PRESETS, SEARCH_KEYS } from '../../src/llm/presets.mjs';
import { catalogRows } from '../../src/llm/admin.mjs';

type Guide = { env?: string; url: string; steps: string[]; source: string; prefix?: string; card?: boolean; note?: string };

const guides = KEY_GUIDES as unknown as Record<string, Guide>;
const providers = PROVIDER_PRESETS as unknown as { keyEnv?: string | null; accountEnv?: string | null }[];
const engines = SEARCH_KEYS as unknown as { env: string }[];

describe('key guides', () => {
  it('give numbered steps, the sign-up page and a documentation source for every key', () => {
    for (const [env, guide] of Object.entries(guides)) {
      expect(env).toMatch(/^[A-Z0-9_]+$/);
      expect(guide.steps.length, env).toBeGreaterThanOrEqual(2);
      expect(guide.steps.every((step) => step.trim().length > 10), env).toBe(true);
      expect(guide.url, env).toMatch(/^https:\/\//);
      expect(guide.source, env).toMatch(/^https:\/\//);
    }
    expect(GUIDES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('name the variable the key must be saved under, and flag the traps', () => {
    expect(guides.GROQ_API_KEY.steps.at(-1)).toContain('GROQ_API_KEY');
    expect(guides.TAVILY_API_KEY.steps.at(-1)).toContain('TAVILY_API_KEY');
    expect(guides.CLOUDFLARE_API_TOKEN.steps.join(' ')).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(guides.LANGSEARCH_API_KEY.prefix).toBeUndefined();
    expect(guides.GROQ_API_KEY.prefix).toBe('gsk_');
    expect(guides.BRAVE_API_KEY.card).toBe(true);
  });

  it('cover every key, account and address a person has to create by hand', () => {
    const handMade = [...providers.map((provider) => provider.keyEnv), ...providers.map((provider) => provider.accountEnv), ...engines.map((engine) => engine.env)].filter(Boolean) as string[];
    expect(handMade.filter((env) => !guideFor(env))).toEqual([]);
  });

  it('find a guide by the exact variable name and skip names they do not know', () => {
    expect(guideFor('GROQ_API_KEY')).toMatchObject({ url: 'https://console.groq.com/keys', prefix: 'gsk_' });
    expect(guideFor('NOT_A_KEY')).toBeNull();
    expect(guideFor('groq_api_key')).toBeNull();
    expect(guidesFor(['GROQ_API_KEY', null, 'NOT_A_KEY', 'TAVILY_API_KEY', undefined]).map((guide) => guide.env)).toEqual(['GROQ_API_KEY', 'TAVILY_API_KEY']);
  });

  it('reach the router page on every model and search row, with the date they were checked', () => {
    const rows = catalogRows({ env: {} });
    const model = (id: string) => rows.models.find((row: { id: string }) => row.id === id);
    const search = (env: string) => rows.search.find((row: { env: string }) => row.env === env);
    expect(model('groq').guide).toEqual([{ env: 'GROQ_API_KEY', ...guides.GROQ_API_KEY }]);
    expect(model('custom').guide.map((guide: { env: string }) => guide.env)).toEqual(['CUSTOM_LLM_API_KEY']);
    expect(model('cloudflare').guide.map((guide: { env: string }) => guide.env)).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    expect(model('pollinations').guide).toEqual([]);
    expect(search('BRAVE_API_KEY').guide[0]).toMatchObject({ env: 'BRAVE_API_KEY', card: true });
    expect(rows.guidesChecked).toBe(GUIDES_CHECKED);
  });
});
