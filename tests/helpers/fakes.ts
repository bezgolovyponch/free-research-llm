export const FAIL = Symbol('fail');

type Choice = { field: string; options: number; ids?: unknown[] };
type Request = { task?: string; tier?: string; purpose?: string; temperature?: number; avoid?: string[]; choice?: Choice; messages: { role: string; content: string }[] };
type Handler = (request: Request, index: number) => unknown;
type Script = Record<string, unknown>;

const LETTERS = 'ABCDEFGHIJKLM';

export function seq(...replies: unknown[]): Handler {
  return (_request, index) => replies[Math.min(index, replies.length - 1)];
}

export function shownLetter(choice: Choice | undefined, id: unknown) {
  const at = (choice?.ids ?? []).findIndex((known) => String(known).toUpperCase() === String(id).trim().toUpperCase());
  return at < 0 ? null : LETTERS[at];
}

function asShown(data: unknown, choice?: Choice) {
  if (!choice?.ids || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  const letter = shownLetter(choice, (data as Record<string, unknown>)[choice.field]);
  return letter ? { ...(data as Record<string, unknown>), [choice.field]: letter } : data;
}

export function fakeRouter(script: Script = {}, { providers = ['p1', 'p2', 'p3'], models = {} }: { providers?: string[]; models?: Record<string, string> } = {}) {
  const calls: Request[] = [];
  const outcomes: { provider: string; model?: string; purpose: string; passed: boolean }[] = [];
  const counts: Record<string, number> = {};
  return {
    calls,
    outcomes,
    count: (task: string) => calls.filter((call) => call.task === task).length,
    userText: (task: string, index = 0) => calls.filter((call) => call.task === task)[index]?.messages.map((message) => message.content).join('\n') ?? '',
    async complete(request: Request) {
      const task = String(request.task ?? '');
      const index = counts[task] ?? 0;
      counts[task] = index + 1;
      calls.push(request);
      const entry = script[task];
      const data = typeof entry === 'function' ? await (entry as Handler)(request, index) : entry;
      if (data === FAIL || data === undefined) throw new Error(`no model answered ${task}`);
      const avoided = new Set(request.avoid ?? []);
      const provider = providers.find((id) => !avoided.has(id)) ?? providers[0];
      return { provider, model: models[provider] ?? `${provider}-model`, data: asShown(data, request.choice) };
    },
    recordOutcome(outcome: { provider: string; model?: string; purpose: string; passed: boolean }) {
      outcomes.push(outcome);
    },
  };
}

export function fakeEmbedder(order: null | number[] | ((query: string, candidates: string[]) => number[]) = (_query, candidates) => candidates.map((_, index) => index), medoid: number | null = 0) {
  const calls: { query: string; candidates: string[]; k: number }[] = [];
  return {
    calls,
    lastModel: order === null ? null : 'fake-embed',
    failures: [] as unknown[],
    failureNote: () => '',
    async rank(query: string, candidates: string[], k = candidates.length) {
      calls.push({ query, candidates, k });
      if (order === null) return null;
      const full = typeof order === 'function' ? order(query, candidates) : order;
      return { model: 'fake-embed', order: full.filter((index) => index < candidates.length).slice(0, k) };
    },
    async medoid(texts: string[]) {
      return order === null || !texts.length ? null : medoid;
    },
  };
}

export function lettersOf(request: Request) {
  const text = request.messages[request.messages.length - 1].role === 'user' && request.messages.length > 2 ? request.messages[1].content : request.messages[request.messages.length - 1].content;
  return Object.fromEntries([...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((match) => [match[2], match[1]]));
}

export function pickLetter(request: Request, wanted: (text: string) => boolean, none = 'N') {
  const found = Object.entries(lettersOf(request)).find(([text]) => wanted(text));
  return found ? found[1] : none;
}
