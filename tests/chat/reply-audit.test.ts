import { describe, expect, it } from 'vitest';
import { ReplyAudit, auditFeedback, shellLines, urlsIn } from '../../src/chat/reply-audit.mjs';

const audit = new ReplyAudit({
  allowedUrls: ['https://nodejs.org/en/download', 'https://www.kleinanzeigen.de/s-anzeige/fort-focus/3545280081-216-17128'],
  allowedHosts: ['127.0.0.1:4600'],
  commands: ['npm start', 'node src/frl.mjs url', 'git clone https://github.com/bezgolovyponch/free-research-llm.git', 'node src/frl.mjs keys import', 'tailscale funnel --bg <port>'],
});

describe('ReplyAudit', () => {
  it('removes invented links and keeps links the app knows', () => {
    const r = audit.audit('Open https://app.example.com/research/x or http://127.0.0.1:4600/#p=cars, listing https://www.kleinanzeigen.de/s-anzeige/fort-focus/3545280081-216-17128.');
    expect(r.passed).toBe(false);
    expect(r.issues.map((i) => i.type)).toEqual(['unverified-link']);
    expect(r.text).not.toContain('app.example.com');
    expect(r.text).toContain('http://127.0.0.1:4600/#p=cars');
    expect(r.text).toContain('kleinanzeigen.de/s-anzeige/fort-focus');
  });

  it('removes key values, real-looking or made up', () => {
    const r = audit.audit('The API keys are: API_KEY=abcd1234, SECRET_KEY=efgh5678 and gsk_' + 'a'.repeat(44));
    expect(r.issues.filter((i) => i.type === 'secret').length).toBeGreaterThanOrEqual(2);
    expect(r.text).not.toMatch(/abcd1234|efgh5678|gsk_a{10}/);
  });

  it('flags commands that are not in the documents', () => {
    const r = audit.audit('Run:\n```bash\ngit add .\ngit commit -m "Your commit message"\nnpm start\n```\nthen `node src/frl.mjs url` and `tailscale funnel --bg 4600`.');
    expect(r.issues.filter((i) => i.type === 'unverified-command').map((i) => i.detail)).toEqual(['git add .', 'git commit -m "Your commit message"']);
    expect(r.issues.some((i) => i.type === 'placeholder')).toBe(true);
  });

  it('flags a claimed action that did not run, and accepts one that did', () => {
    expect(audit.audit('All non-conversation research entries have been removed from the active list.').issues).toEqual([{ type: 'claims-undone-action', detail: expect.stringContaining('delete') }]);
    expect(audit.audit("I'm opening the research project for you now.").issues[0].type).toBe('claims-undone-action');
    expect(audit.audit("I'm opening the research project for you now.", { done: [{ type: 'open', ok: true }] }).passed).toBe(true);
    expect(audit.audit('I have re-researched D2.', { done: [{ type: 'rerun', ok: true }] }).passed).toBe(true);
    expect(audit.audit('Press the button below to start the research.').passed).toBe(true);
  });

  it('extracts links and shell lines and writes feedback for the retry', () => {
    expect(urlsIn('see https://a.b/c. and (https://d.e/f)')).toEqual(['https://a.b/c', 'https://d.e/f']);
    expect(shellLines('```\n# comment\n$ npm start\nhello\n```')).toEqual(['npm start']);
    expect(auditFeedback([{ type: 'secret', detail: 'x' }])).toMatch(/secret: x/);
  });
});
