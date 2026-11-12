import { PROVIDER_PRESETS, SEARCH_KEYS } from '../src/llm/presets.mjs';

const PRESET_ENV_FIELDS = ['keyEnv', 'accountEnv', 'baseEnv', 'optionalKeyEnv', 'modelEnv'];

export function credentialNames(presets = PROVIDER_PRESETS, searchKeys = SEARCH_KEYS) {
  const names = [...presets.flatMap((p) => PRESET_ENV_FIELDS.map((f) => p[f])), ...searchKeys.map((k) => k.env)];
  return [...new Set(names.filter(Boolean))].sort();
}

export function hermeticEnv(overrides = {}, presets = PROVIDER_PRESETS, searchKeys = SEARCH_KEYS) {
  const blank = Object.fromEntries(credentialNames(presets, searchKeys).map((name) => [name, '']));
  return { ...blank, FRL_KEYCHAIN: '0', FRL_LOCAL_AUTOSTART: '0', ...overrides };
}
