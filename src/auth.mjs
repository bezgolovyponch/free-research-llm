import crypto from 'node:crypto';

const COOKIE = 'frl_token';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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
  constructor({ token = '' } = {}) {
    this.token = token;
  }

  isLoopback(req) {
    return LOOPBACK.has(req.socket?.remoteAddress ?? '');
  }

  presented(req, url) {
    const bearer = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
    return url.searchParams.get('token') || bearer || cookieValue(req.headers?.cookie, COOKIE);
  }

  decide(req, url) {
    if (this.isLoopback(req)) return { allowed: true };
    if (!this.token) return { allowed: false, reason: 'remote access is off: start the app with "frl start --remote" (it creates an access token)' };
    const given = this.presented(req, url);
    if (!given || !sameSecret(given, this.token)) return { allowed: false, reason: 'missing or wrong access token: open the link printed by "frl url"' };
    return { allowed: true, setCookie: url.searchParams.has('token') ? `${COOKIE}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` : null };
  }
}
