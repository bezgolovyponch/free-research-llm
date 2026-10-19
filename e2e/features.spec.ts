import { expect, test, type Page } from '@playwright/test';

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: 'serial' });

test('app assistant: research requests become a proposal that only the Confirm button turns into a research', async ({ page }) => {
  await page.goto('/#page=assistant');
  await expect(page.getByRole('heading', { name: 'App assistant' })).toBeVisible();
  await noSideScroll(page);
  await page.locator('#apFile').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('e-bike fleet notes') });
  await expect(page.locator('#apFiles .attach-chip')).toContainText('notes.txt');
  const before = (await (await page.request.get('/api/projects')).json()).length;
  await page.locator('#apIn').fill('please start a new research on e-bikes');
  await page.locator('#apSend').click();
  const reply = page.locator('#apMsgs .msg.assistant').last();
  await expect(reply).toContainText('press the button', { timeout: 20000 });
  await expect(page.locator('#apMsgs .msg.user').last()).toContainText('notes.txt');
  await expect(reply.locator('.proposal')).toContainText('Start research');
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(before);
  await reply.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('#apMsgs .msg.app').last()).toContainText('Research created', { timeout: 20000 });
  await expect(reply.locator('.proposal')).toContainText('done');
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(before + 1);
});

test('results tab shows what was delivered and has its own chat', async ({ page }) => {
  await page.goto('/');
  await page.locator('#inQuestion').fill('Which used vans bought in Germany resell in Czechia with a 10% margin?');
  await page.getByRole('button', { name: 'Research now' }).click();
  await page.locator('.tabs .tab', { hasText: 'Results' }).click();
  await expect(page.locator('#resultsBody')).toContainText('What the research found', { timeout: 40000 });
  await expect(page.locator('#resultsBody')).toContainText('Memo verdict');
  await noSideScroll(page);
  await expect(page.locator('#resultsBody')).toContainText('Best estimate');
  const csvHref = await page.locator('#resultsBody a', { hasText: 'Pieces & actions (.csv)' }).getAttribute('href');
  const csv = await page.request.get(csvHref!);
  expect(csv.headers()['content-disposition']).toContain('-pieces.csv');
  expect(await csv.text()).toContain('piece,title,role,grade,answer,action,why,next step');
  const json = await (await page.request.get((await page.locator('#resultsBody a', { hasText: 'Everything (.json)' }).getAttribute('href'))!)).json();
  expect(json.confidence).toHaveProperty('byChecks');
  expect(Array.isArray(json.actions)).toBe(true);
  await page.locator('.tabs .tab', { hasText: 'Chat' }).click();
  await expect(page.locator('#chatTitle')).toContainText('Results');
  await page.locator('#chatFile').setInputFiles({ name: 'quote.csv', mimeType: 'text/csv', buffer: Buffer.from('item,eur\ntransport,350\n') });
  await page.locator('#chatIn').fill('what does my transport quote change?');
  await page.locator('#chatSend').click();
  await expect(page.locator('#chatMsgs .msg.user').last()).toContainText('quote.csv');
  await expect(page.locator('#chatMsgs .msg.assistant').last()).toContainText('DEMO', { timeout: 20000 });
});

test('terminal opens a real shell from the button and runs a command', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.locator('#termMode')).toContainText('shell', { timeout: 20000 });
  await expect(page.locator('#termHost .xterm')).toBeVisible();
  await page.locator('#termHost .xterm').click();
  await page.keyboard.type('echo FRL_TERM_$((6*7))');
  await page.keyboard.press('Enter');
  await expect(page.locator('#termHost .xterm-rows')).toContainText('FRL_TERM_42', { timeout: 15000 });
  await expect(page.locator('#termCmds')).toContainText('Check keys');
  await noSideScroll(page);
});

test('tree tab: tick pieces, run the loop only on them; gates, sources and regression checks per piece', async ({ page }) => {
  await page.goto('/');
  await page.locator('#inQuestion').fill('Which used scooters bought in Austria resell in Slovakia with a 20% margin?');
  await page.getByRole('button', { name: 'Research now' }).click();
  await expect(page.locator('#pieceTable')).toContainText('Sub-question', { timeout: 40000 });
  await expect(page.locator('#pieceTable tr[data-row="D1.1"]')).toBeVisible();
  await page.locator('#outline [data-check="D1.1"]').check();
  await page.locator('#outline [data-check="D2.1"]').check();
  await expect(page.locator('#treeBar')).toContainText('D1.1, D2.1');
  await page.locator('#outline .orow[data-node="D1.1"]').click();
  await expect(page.locator('#pieceReport')).toContainText('Research process');
  await expect(page.locator('#pieceReport')).toContainText('Mechanical gates', { timeout: 40000 });
  await page.locator('.tabs .tab', { hasText: 'Sources' }).click();
  await expect(page.locator('#sourceList')).toContainText('D1.1');
  await page.locator('.tabs .tab', { hasText: 'Gates & logs' }).click();
  await expect(page.locator('#gatesBody')).toContainText('Mechanical gates per piece');
  await expect(page.locator('#gatesBody')).toContainText('Event log');
  await page.locator('.tabs .tab', { hasText: 'Chat' }).click();
  await page.locator('#chatDesired').fill('a baseline number in EUR');
  await page.locator('#chatIn').fill('re-research this again with 2026 data');
  await page.locator('#chatSend').click();
  await expect(page.locator('#chatMsgs .msg.assistant').last()).toContainText('DEMO assistant', { timeout: 20000 });
  await page.locator('#inspClose').click();
  await page.locator('.tabs .tab', { hasText: 'Gates & logs' }).click();
  await expect(page.locator('#gatesBody')).toContainText('a baseline number in EUR', { timeout: 40000 });
  await page.locator('.tabs .tab', { hasText: 'Tree & pieces' }).click();
  await page.locator('#tbLoopSel').click();
  await expect(page.locator('#loopBox')).toContainText('Selected pieces (D1.1, D2.1 · ');
  await page.locator('#impHours').fill('0.01');
  await page.locator('#impStart').click();
  await expect(page.locator('#loopBox')).toContainText('Scope: selected pieces D1.1, D2.1', { timeout: 20000 });
  await noSideScroll(page);
});


test('researches list shows only name, start time, active dot and node count; map selection drives a scoped loop', async ({ page }) => {
  await page.goto('/');
  await page.locator('#inQuestion').fill('Where should I open a coffee kiosk in Brno for the best margin?');
  await page.getByRole('button', { name: 'Research now' }).click();
  await expect(page.locator('#progText')).toContainText(/researched/, { timeout: 40000 });
  const id = new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get('p')!;
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}`)).json()).phase, { timeout: 40000 }).toBe('done');
  const row = page.locator(`#projList .pitem[data-open="${id}"]`);
  await expect(row.locator('.m')).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2} · \d+ nodes$/);
  await expect(row.locator('.m')).not.toContainText(/ok|runs|done/);
  await page.locator('.tabs .tab', { hasText: 'Decomposition map' }).click();
  await page.locator('#btnMapSel').click();
  const nodes = await (await page.request.get(`/api/projects/${id}`)).json();
  const leaf = nodes.nodes.find((n: { id: string; parentId: string }) => n.parentId !== 'Q');
  await page.locator('#cloud g.node').filter({ has: page.locator('text.nid', { hasText: new RegExp(`^${leaf.id.replace('.', '\\.')}$`) }) }).dispatchEvent('click');
  await expect(page.locator('#mapSelInfo')).toContainText('1 selected');
  await page.locator('#cloud g.node').filter({ has: page.locator('text.nid', { hasText: /^Q$/ }) }).dispatchEvent('click');
  await expect(page.locator('#mapSelInfo')).toContainText('1 excluded');
  await noSideScroll(page);
  if (await page.locator('#btnLoop').isVisible()) {
    await page.locator('#btnLoop').click();
    await expect(page.locator('#loopSel')).toHaveText('Selected pieces (1)…');
    await page.locator('#loopSel').click();
  } else {
    await page.locator('#moreBtn').click();
    await page.locator('#mLoop').click();
    await page.locator('input[name="lscope"][value="sel"]').check();
  }
  await expect(page.locator('#loopBox')).toContainText('pieces in focus, excluded Q');
  await page.locator('#impHours').fill('0.01');
  await page.locator('#impStart').click();
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}`)).json()).improve?.exclude, { timeout: 20000 }).toEqual(['Q']);
  expect((await (await page.request.get(`/api/projects/${id}`)).json()).improve.scope).toEqual([leaf.id]);
  await page.request.post(`/api/projects/${id}/improve/stop`);
});

test('the + next to the models indicator opens the router page: strategy, ranked route per role with reasons, providers', async ({ page }) => {
  await page.goto('/');
  if (await page.locator('#menuBtn').isVisible()) await page.locator('#menuBtn').click();
  await page.locator('#btnRouter').click();
  const body = page.locator('#rtBody');
  await expect(page.getByRole('heading', { name: 'Models & router' })).toBeVisible();
  await expect(body.getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'true');
  await expect(body.locator('.rt-roles .card').first()).toContainText('Deep role');
  await expect(body.locator('.rt-row[data-rt="pollinations"] .why').first()).toContainText('disabled by FRL_POLLINATIONS=0');
  await expect(body.locator('h2', { hasText: 'In use' })).toBeVisible();
  await expect(body.locator('h2', { hasText: 'Can be added' })).toBeVisible();
  await expect(body.locator('[data-use]')).toHaveCount(0);
  await expect(body.locator('[data-rrow="groq"]')).toContainText('Adds: capability 4/5');
  await expect(body.locator('[data-rrow="groq"]')).toContainText('1,000 req/day');
  await expect(body.locator('[data-rrow="groq"] a[href="https://console.groq.com/keys"]').first()).toBeVisible();
  await expect(body.locator('[data-rrow="groq"] .rt-guide')).toContainText('How to get it');
  await expect(body.locator('[data-rrow="groq"] .rt-guide')).toContainText('Create API Key');
  await expect(body.locator('[data-rrow="groq"] .rt-guide')).toContainText('gsk_');
  await expect(body.locator('[data-rrow="groq"] .rt-guide')).toContainText('checked 2026-10-19');
  await expect(body.locator('[data-rrow="groq"] .rt-guide ol.steps li')).toHaveCount(4);
  await expect(body.locator('[data-rrow="groq"] input[type="password"]')).toBeVisible();
  await noSideScroll(page);
  await body.getByRole('radio', { name: 'Fastest' }).click();
  await expect(body.getByRole('radio', { name: 'Fastest' })).toHaveAttribute('aria-checked', 'true');
  await expect(body).toContainText('Lowest median reply time first');
  await body.getByRole('radio', { name: 'Custom' }).click();
  await expect(body).toContainText('Your own order, the same for both roles');
  await body.getByRole('radio', { name: 'Balanced' }).click();
  await body.locator('[data-rsave="groq"]').click();
  await expect(body.locator('[data-rmsg="groq"]')).toContainText('type or paste a value first');
});
