export const TYPICAL_PROMPT_TOKENS = 7000;
export const TYPICAL_OUTPUT_TOKENS = 400;
export const SPEED_BUDGET_S = 100;
export const SMALL_CALL = { prompt: 1500, output: 100 };
const MIN_TIMED_PROMPT = 200;
const BENCH_PROMPT = 'Summarise in two sentences why coastal rural land in southern Spain can be cheap to buy but costly to prepare. '.repeat(70);

export function projectedSeconds({ prefill, decode }) {
  if (!(prefill > 0) || !(decode > 0)) return Infinity;
  return TYPICAL_PROMPT_TOKENS / prefill + TYPICAL_OUTPUT_TOKENS / decode;
}

export function smallCallSeconds({ prefill, decode }) {
  if (!(prefill > 0) || !(decode > 0)) return Infinity;
  return SMALL_CALL.prompt / prefill + SMALL_CALL.output / decode;
}

export function speedVerdict(speed) {
  const seconds = projectedSeconds(speed);
  const usable = smallCallSeconds(speed) <= SPEED_BUDGET_S;
  const text = `reads ${Math.round(speed.prefill || 0)} tokens/s, writes ${(speed.decode || 0).toFixed(1)} tokens/s: a typical ${TYPICAL_PROMPT_TOKENS}-token research call takes ${Number.isFinite(seconds) ? Math.round(seconds) : '∞'} s`;
  return { usable, seconds, text: usable ? `${text}; it gets the calls that fit its speed` : `too slow for research (${text}; even a short ${SMALL_CALL.prompt}-token call takes ${Math.round(smallCallSeconds(speed))} s, the limit is ${SPEED_BUDGET_S} s); a graphics card that llama.cpp can use makes it fast enough` };
}

export async function measureSpeed(baseURL, { fetchImpl = fetch, model = 'local', timeoutMs = 150000, apiKey = '' } = {}) {
  const started = Date.now();
  const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: `Run ${started.toString(36)}-${Math.random().toString(36).slice(2)}. ${BENCH_PROMPT} /no_think` }], max_tokens: 24, temperature: 0, cache_prompt: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const t = body.timings ?? {};
  if (t.prompt_per_second && t.predicted_per_second && (t.prompt_n ?? 0) >= MIN_TIMED_PROMPT) return { prefill: t.prompt_per_second, decode: t.predicted_per_second };
  const seconds = Math.max(0.001, (Date.now() - started) / 1000);
  const promptTokens = body.usage?.prompt_tokens ?? 0;
  const outTokens = body.usage?.completion_tokens ?? 0;
  return { prefill: promptTokens / seconds, decode: outTokens / seconds };
}
