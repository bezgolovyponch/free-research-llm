export const PEER_ENDPOINTS = Object.freeze([
  { id: 'ollama', env: 'OLLAMA_BASE_URL', port: 11434, label: 'Ollama' },
  { id: 'llamacpp-lan', env: 'LLAMACPP_LAN_URL', port: 8090, label: 'llama.cpp' },
]);

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/i;

export function peerHost(raw) {
  const host = String(raw ?? '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  if (!HOST.test(host)) throw new Error('give the other PC\'s Wi-Fi address, e.g. node src/frl.mjs local pc 192.168.5.26');
  return host;
}

export async function probePeer(rawHost, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const host = peerHost(rawHost);
  return Promise.all(PEER_ENDPOINTS.map(async (endpoint) => {
    const url = `http://${host}:${endpoint.port}/v1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}/models`, { signal: controller.signal });
      if (!res.ok) return { ...endpoint, url, ok: false, detail: `HTTP ${res.status}` };
      const body = await res.json();
      const models = (body.data ?? body.models ?? []).map((m) => String(m.id ?? m.name ?? '')).filter(Boolean);
      return { ...endpoint, url, ok: models.length > 0, models, detail: models.length ? models.join(', ') : 'running, but no model is loaded yet' };
    } catch (error) {
      return { ...endpoint, url, ok: false, detail: error.name === 'AbortError' ? 'no answer (PC off or asleep, server not started, or blocked by Windows Firewall)' : `no answer (${error.message})` };
    } finally {
      clearTimeout(timer);
    }
  }));
}
