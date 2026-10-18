const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseEcbRates(xml) {
  const rates = { EUR: 1 };
  for (const m of String(xml ?? '').matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  return rates;
}

export class ExchangeRates {
  constructor({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = null;
  }

  async rates() {
    if (this.cache && this.now() - this.cache.at < DAY_MS) return this.cache.rates;
    try {
      const res = await this.fetchImpl(ECB_DAILY);
      if (!res.ok) return this.cache?.rates ?? { EUR: 1 };
      this.cache = { at: this.now(), rates: parseEcbRates(await res.text()) };
      return this.cache.rates;
    } catch {
      return this.cache?.rates ?? { EUR: 1 };
    }
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
