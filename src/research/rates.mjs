const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const WIDE_DAILY = 'https://open.er-api.com/v6/latest/EUR';
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseEcbRates(xml) {
  const rates = { EUR: 1 };
  for (const m of String(xml ?? '').matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  return rates;
}

export function parseWideRates(body) {
  const rates = {};
  if (body?.result !== 'success' || body?.base_code !== 'EUR') return rates;
  for (const [code, rate] of Object.entries(body.rates ?? {})) if (/^[A-Z]{3}$/.test(code) && Number(rate) > 0) rates[code] = Number(rate);
  return rates;
}

export class ExchangeRates {
  constructor({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = null;
  }

  async read(url, parse) {
    try {
      const res = await this.fetchImpl(url);
      return res.ok ? parse(res) : null;
    } catch {
      return null;
    }
  }

  async rates() {
    if (this.cache && this.now() - this.cache.at < DAY_MS) return this.cache.rates;
    const [ecb, wide] = await Promise.all([
      this.read(ECB_DAILY, async (res) => parseEcbRates(await res.text())),
      this.read(WIDE_DAILY, async (res) => parseWideRates(await res.json())),
    ]);
    if (!ecb && !wide) return this.cache?.rates ?? { EUR: 1 };
    this.cache = { at: this.now(), rates: { ...(wide ?? {}), ...(ecb ?? {}), EUR: 1 } };
    return this.cache.rates;
  }

  async converter() {
    const rates = await this.rates();
    return (value, from, to) => {
      if (!from || !to || from === to) return value;
      if (!rates[from] || !rates[to]) return null;
      return (value / rates[from]) * rates[to];
    };
  }
}
