import { describe, expect, it } from 'vitest';
import { REACHABLE_PAGE, RemoteVisits } from '../src/visits.mjs';

const req = (address: string) => ({ socket: { remoteAddress: address } });

describe('RemoteVisits', () => {
  it('notes each other device once per outcome per quiet window, with the reason when it was refused', () => {
    let now = 0;
    const notes: string[] = [];
    const visits = new RemoteVisits({ note: (m: string) => notes.push(m), now: () => now, quietMs: 1000 });
    expect(visits.record(req('::ffff:192.168.5.30'), '/', { allowed: false, reason: 'missing or wrong access token' })).toBe(true);
    expect(visits.record(req('::ffff:192.168.5.30'), '/', { allowed: false, reason: 'missing or wrong access token' })).toBe(false);
    expect(visits.record(req('192.168.5.30'), '/', { allowed: true, share: 'p1' })).toBe(true);
    expect(visits.record(req('192.168.5.31'), '/', { allowed: true })).toBe(true);
    now = 1500;
    expect(visits.record(req('192.168.5.30'), '/', { allowed: true, share: 'p1' })).toBe(true);
    expect(notes).toEqual([
      'other device 192.168.5.30 opened / · refused: missing or wrong access token',
      'other device 192.168.5.30 opened / · research link (p1)',
      'other device 192.168.5.31 opened / · full access',
      'other device 192.168.5.30 opened / · research link (p1)',
    ]);
    expect(visits.seen.size).toBe(1);
  });

  it('notes every refused page separately and again after 30 seconds, so a failing device is visible', () => {
    let now = 0;
    const notes: string[] = [];
    const visits = new RemoteVisits({ note: (m: string) => notes.push(m), now: () => now, quietMs: 600000 });
    const refused = { allowed: false, reason: 'this research link was turned off or replaced' };
    expect(visits.record(req('192.168.5.26'), '/', refused)).toBe(true);
    expect(visits.record(req('192.168.5.26'), '/api/status', refused)).toBe(true);
    expect(visits.record(req('192.168.5.26'), '/', refused)).toBe(false);
    now = 31000;
    expect(visits.record(req('192.168.5.26'), '/', refused)).toBe(true);
    expect(notes).toHaveLength(3);
  });

  it('has a reachability page that holds no app data', () => {
    expect(REACHABLE_PAGE).toContain('Free Research LLM is reachable');
    expect(REACHABLE_PAGE).not.toMatch(/token|share=/i);
  });
});
