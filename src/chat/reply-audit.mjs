import { SECRET_PATTERNS } from '../secrets.mjs';

const URL_PATTERN = /https?:\/\/[^\s)\]>"'`<]+/g;
const ASSIGNED_SECRET = /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*["']?[^\s"'`]{6,}/g;
const PLACEHOLDER = /\bexample\.(?:com|org|net)\b|\byour[-_ ](?:api[-_ ])?(?:key|token|password)\b|<your[^>]*>|\babcd1234\b|\bxxxx+\b|lorem ipsum|your commit message/i;
const SHELL_START = /^(?:\$\s*)?(git|npm|npx|node|frl|curl|docker|ssh|sudo|winget|brew|tailscale|systemctl|systemd-creds|gcloud|schtasks|powershell|pwsh|cd|chmod|\.\/[\w.-]+)\b/;
const CLAIMS = [
  ['create', /\b(?:i(?:'ve| have)?|has been|have been|was|is now)\s+(?:just\s+)?(?:created|started a new research|added a new research)\b|\bi(?:'m| am) (?:creating|starting a new research)\b/i],
  ['delete', /\b(?:i(?:'ve| have)?|has been|have been|were|was)\s+(?:just\s+)?(?:deleted|removed)\b|\bi(?:'m| am) (?:deleting|removing)\b/i],
  ['open', /\bi(?:'ve| have)?\s+(?:just\s+)?opened\b|\bi(?:'m| am) opening\b/i],
  ['stop', /\b(?:i(?:'ve| have)?|has been|was)\s+(?:just\s+)?stopped\b|\bi(?:'m| am) stopping\b/i],
  ['improve', /\b(?:i(?:'ve| have)?|has been|was)\s+(?:just\s+)?started the (?:self-improving )?loop\b|\bi(?:'m| am) starting the (?:self-improving )?loop\b/i],
  ['command', /\b(?:i(?:'ve| have)?|has been|have been|was)\s+(?:just\s+)?(?:committed|pushed|compiled|installed|restarted|deployed|merged|built)\b|\bi(?:'m| am) (?:committing|pushing|compiling|installing|deploying|merging)\b/i],
  ['edit', /\b(?:i(?:'ve| have)?|has been|was)\s+(?:just\s+)?(?:edited|updated|changed|re-?researched|split)\b/i],
];

export function urlsIn(text) {
  return [...String(text ?? '').matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}

function normalizeUrl(url) {
  return String(url).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
}

export function shellLines(text) {
  const body = String(text ?? '');
  const fenced = [...body.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n'));
  const inline = [...body.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fenced, ...inline].map((l) => l.trim().replace(/^\$\s*/, '')).filter((l) => l && !l.startsWith('#') && SHELL_START.test(l));
}

function normalizeCommand(line) {
  return line.replace(/\s+/g, ' ').trim().toLowerCase();
}

export class ReplyAudit {
  constructor({ allowedUrls = [], allowedHosts = [], commands = [] } = {}) {
    this.urls = new Set(allowedUrls.map(normalizeUrl));
    this.hosts = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
    this.commands = commands.map(normalizeCommand);
  }

  urlAllowed(url) {
    if (this.urls.has(normalizeUrl(url))) return true;
    try {
      return this.hosts.has(new URL(url).host.toLowerCase());
    } catch {
      return false;
    }
  }

  commandKnown(line) {
    const wanted = normalizeCommand(line);
    return this.commands.some((c) => wanted === c || (c.includes('<') && wanted.startsWith(c.slice(0, c.indexOf('<')).trim())));
  }

  audit(reply, { done = [] } = {}) {
    let text = String(reply ?? '');
    const issues = [];
    for (const url of urlsIn(text)) {
      if (this.urlAllowed(url)) continue;
      issues.push({ type: 'unverified-link', detail: url });
      text = text.split(url).join('[link removed: not found in the app or its documents]');
    }
    for (const [name, pattern] of SECRET_PATTERNS) {
      const global = new RegExp(pattern.source, 'g');
      if (!global.test(text)) continue;
      issues.push({ type: 'secret', detail: name });
      text = text.replace(new RegExp(pattern.source, 'g'), '[secret removed]');
    }
    if (ASSIGNED_SECRET.test(text)) {
      issues.push({ type: 'secret', detail: 'a key or token value' });
      text = text.replace(ASSIGNED_SECRET, (m) => `${m.split(/[=:]/)[0].trim()}=[secret removed]`);
    }
    ASSIGNED_SECRET.lastIndex = 0;
    if (PLACEHOLDER.test(text)) issues.push({ type: 'placeholder', detail: text.match(PLACEHOLDER)[0] });
    for (const line of shellLines(text)) if (!this.commandKnown(line)) issues.push({ type: 'unverified-command', detail: line });
    const doneTypes = new Set(done.filter((a) => a.ok).map((a) => (['edit', 'add', 'remove', 'expand', 'rerun', 'suggest'].includes(a.type) ? 'edit' : a.type)));
    for (const [type, pattern] of CLAIMS) if (pattern.test(text) && !doneTypes.has(type)) issues.push({ type: 'claims-undone-action', detail: `says "${text.match(pattern)[0]}" but no ${type} action ran` });
    return { text, issues, passed: issues.length === 0 };
  }
}

export function auditFeedback(issues) {
  return `Your previous reply failed the app's mandatory audit:\n${issues.map((i) => `- ${i.type}: ${i.detail}`).join('\n')}\nWrite the reply again. Use only links, commands and facts given above. Never write keys or tokens. Never say an action happened unless it is listed as done; for a proposal, tell the user to press its button.`;
}
