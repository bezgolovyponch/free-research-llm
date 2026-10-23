import crypto from 'node:crypto';

const COOKIE = 'frl_token';
const SHARE_COOKIE = 'frl_share';
const YEAR_SECONDS = 31536000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'tailscale-funnel-request', 'tailscale-user-login'];

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function newAccessToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export class AccessGate {
  constructor({ token = '', behindProxy = false, shares = null } = {}) {
    this.token = token;
    this.behindProxy = behindProxy;
    this.shares = shares;
  }

  proxied(req) {
    return PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined);
  }

  isLoopback(req) {
    return !this.behindProxy && !this.proxied(req) && LOOPBACK.has(req.socket?.remoteAddress ?? '');
  }

  presented(req, url) {
    const bearer = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
    return url.searchParams.get('token') || bearer || cookieValue(req.headers?.cookie, COOKIE);
  }

  sharedProject(req, url) {
    const given = url.searchParams.get('share') || cookieValue(req.headers?.cookie, SHARE_COOKIE);
    return this.shares?.match(given) ?? null;
  }

  decide(req, url) {
    if (this.isLoopback(req)) return { allowed: true };
    const given = this.token ? this.presented(req, url) : '';
    if (given && sameSecret(given, this.token)) return { allowed: true, setCookie: url.searchParams.has('token') ? `${COOKIE}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${YEAR_SECONDS}` : null };
    const share = this.sharedProject(req, url);
    if (share) return { allowed: true, share, setCookie: url.searchParams.has('share') ? `${SHARE_COOKIE}=${encodeURIComponent(url.searchParams.get('share'))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${YEAR_SECONDS}` : null };
    if (!this.token) return { allowed: false, reason: 'remote access is off: start the app with "frl start --remote" (it creates an access token)' };
    if (url.searchParams.has('share') || cookieValue(req.headers?.cookie, SHARE_COOKIE)) return { allowed: false, reason: 'this research link was turned off or replaced: ask the owner for a new one' };
    return { allowed: false, reason: 'missing or wrong access token: open the link printed by "frl url"' };
  }
}
