import { describe, expect, it } from 'vitest';
import { AccessGate, newAccessToken } from '../src/auth.mjs';

const req = (address: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: address }, headers });
const url = (q = '') => new URL(`http://host/api/status${q}`);

describe('AccessGate', () => {
  it('always lets this Mac in and keeps other devices out when no token is set', () => {
    const gate = new AccessGate();
    expect(gate.decide(req('::ffff:127.0.0.1'), url()).allowed).toBe(true);
    expect(gate.decide(req('192.168.1.9'), url())).toMatchObject({ allowed: false, reason: expect.stringMatching(/remote access is off/) });
  });

  it('accepts the token from the link once, then from the cookie or a bearer header', () => {
    const token = newAccessToken();
    const gate = new AccessGate({ token });
    expect(gate.decide(req('10.0.0.2'), url('?token=wrong')).allowed).toBe(false);
    const first = gate.decide(req('10.0.0.2'), url(`?token=${token}`));
    expect(first.allowed).toBe(true);
    expect(first.setCookie).toMatch(/^frl_token=.*HttpOnly; SameSite=Strict/);
    expect(gate.decide(req('10.0.0.2', { cookie: `a=b; frl_token=${encodeURIComponent(token)}` }), url())).toEqual({ allowed: true, setCookie: null });
    expect(gate.decide(req('10.0.0.2', { authorization: `Bearer ${token}` }), url()).allowed).toBe(true);
  });

  it('does not trust requests a local proxy forwards from the internet (Tailscale Funnel, tunnels)', () => {
    const token = newAccessToken();
    const gate = new AccessGate({ token });
    expect(gate.decide(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), url()).allowed).toBe(false);
    expect(gate.decide(req('127.0.0.1', { 'tailscale-funnel-request': '?1' }), url()).allowed).toBe(false);
    expect(gate.decide(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), url(`?token=${token}`)).allowed).toBe(true);
    const cloud = new AccessGate({ token, behindProxy: true });
    expect(cloud.decide(req('127.0.0.1'), url()).allowed).toBe(false);
    expect(cloud.decide(req('127.0.0.1', { authorization: `Bearer ${token}` }), url()).allowed).toBe(true);
  });
});
