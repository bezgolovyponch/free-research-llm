const DAY_MS = 24 * 60 * 60 * 1000;

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current && (field === 'allow' || field === 'disallow')) current.rules.push({ allow: field === 'allow', path: value });
  }
  return groups;
}

function patternMatches(pattern, target) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(target);
}

export function isAllowed(groups, agent, url) {
  const token = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const applicable = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  const u = new URL(url);
  const target = `${u.pathname}${u.search}`;
  let best = null;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!rule.path && !rule.allow) continue;
    if (!patternMatches(rule.path, target)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

export class RobotsPolicy {
  constructor({ fetchImpl = fetch, agent = 'free-research-llm', now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.agent = agent;
    this.now = now;
    this.cache = new Map();
  }

  async groupsFor(origin) {
    const cached = this.cache.get(origin);
    if (cached && this.now() - cached.at < DAY_MS) return cached.groups;
    let groups;
    try {
      const res = await this.fetchImpl(`${origin}/robots.txt`, { headers: { 'user-agent': this.agent } });
      if (res.status >= 500) groups = [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }];
      else groups = res.ok ? parseRobots(await res.text()) : [];
    } catch {
      groups = [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }];
    }
    this.cache.set(origin, { at: this.now(), groups });
    return groups;
  }

  async allowed(url) {
    return isAllowed(await this.groupsFor(new URL(url).origin), this.agent, url);
  }
}
