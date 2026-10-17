type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function fakeFetch(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) return new Response('not found', { status: 404 });
    return route[1](url, init);
  };
  return Object.assign(impl, { calls }) as typeof impl & { calls: typeof calls };
}
