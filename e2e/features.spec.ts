import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

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

test('app assistant turns a change request into a ticket with two implementers, and creates nothing before the button', async ({ page }) => {
  await page.goto('/#page=assistant');
  const before = (await (await page.request.get('/api/changes')).json()).length;
  await page.locator('#apIn').fill('make the Run button green');
  await page.locator('#apSend').click();
  const reply = page.locator('#apMsgs .msg.assistant').last();
  await expect(reply.locator('.proposal')).toContainText('Green Run button', { timeout: 20000 });
  await expect(reply.getByRole('button', { name: 'Implement with Claude Code' })).toBeVisible();
  await expect(reply.getByRole('button', { name: 'with free models' })).toBeVisible();
  await expect(reply.locator('.proposal')).toContainText('the quality gate decides');
  expect((await (await page.request.get('/api/changes')).json()).length).toBe(before);
  const status = await (await page.request.get('/api/status')).json();
  expect(status.coders.map((c: { id: string }) => c.id)).toEqual(['free', 'claude']);
  await noSideScroll(page);
});

test('results tab shows what was delivered and has its own chat', async ({ page }) => {
  await page.goto('/');
  await page.locator('#inQuestion').fill('Which used vans bought in Germany resell in Czechia with a 10% margin?');
  await page.getByRole('button', { name: 'Research now' }).click();
  await expect(page.locator('#phasePill')).toContainText('done', { timeout: 40000 });
  await page.locator('.tabs .tab', { hasText: 'Results' }).click();
  await expect(page.locator('#resultsBody')).toContainText('What the research found', { timeout: 40000 });
  await expect(page.locator('#resultsBody')).toContainText('Memo verdict');
  await noSideScroll(page);
  await expect(page.locator('#resultsBody')).toContainText('Best estimate');
  await expect(page.locator('#computedResult')).toContainText('Evidence probability');
  await expect(page.locator('#computedResult')).toContainText('Analysis of Competing Hypotheses');
  const csvHref = await page.locator('#resultsBody a', { hasText: 'Pieces & actions (.csv)' }).getAttribute('href');
  const csv = await page.request.get(csvHref!);
  expect(csv.headers()['content-disposition']).toContain('-pieces.csv');
  expect(await csv.text()).toContain('piece,title,role,grade,answer,action,why,next step');
  const json = await (await page.request.get((await page.locator('#resultsBody a', { hasText: 'Everything (.json)' }).getAttribute('href'))!)).json();
  expect(json.confidence).toHaveProperty('byChecks');
  expect(Array.isArray(json.actions)).toBe(true);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#resultsBody a', { hasText: 'All tables (.xlsx' }).click()]);
  expect(download.suggestedFilename()).toMatch(/-results\.xlsx$/);
  const workbookPath = await download.path();
  expect(readFileSync(workbookPath).subarray(0, 2).toString()).toBe('PK');
  await page.locator('.tabs .tab', { hasText: 'Chat' }).click();
  await expect(page.locator('#chatTitle')).toContainText('Results');
  await page.locator('#chatFile').setInputFiles({ name: 'quote.csv', mimeType: 'text/csv', buffer: Buffer.from('item,eur\ntransport,350\n') });
  await page.locator('#chatIn').fill('what does my transport quote change?');
  await page.locator('#chatSend').click();
  await expect(page.locator('#chatMsgs .msg.user').last()).toContainText('quote.csv');
  await expect(page.locator('#chatMsgs .msg.assistant').last()).toContainText('DEMO', { timeout: 20000 });
});

test('candidate table: every plot says why it fits, sorts by any column and filters by tier', async ({ page }) => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const base = await (await page.request.post('/api/projects', { data: { question: 'E2E base research for the plot table', autoRun: false } })).json();
  const plan = (tier: string, verdict: string, entry: number, why: string[]) => ({ tier, verdict, why, tradeoffs: tier === 'trade-off' ? ['sea within 20 km by e-bike: no (sea 32 km)'] : [], potential: [], risks: ['ask the Câmara'], units: 10, areaM2: 1000, entry: { total: entry }, path: 'Rural camping park', checks: [], sources: [] });
  const row = (title: string, value: number, sea: number, months: number, p: object) => ({ title, url: `https://imo.example/anuncio/${title.replace(/\W+/g, '-')}`, price: value, currency: 'EUR', value, unit: 'EUR', area: 1000, areaUnit: 'm²', place: 'Nazaré', country: 'Portugal', countryCode: 'PT', site: { coastKm: sea, beachKm: sea, beaches: 2, viewpoints: 3, attractions: 1, reserves: 0, protectedAreas: 0, hikingRoutes: 1, campsites: 1, lodging: 9, climate: { workable: months, comfortable: months - 3, hottest: 24, coldest: 8 } }, fit: { score: 0.8, hpi: 17.6, zoning: 'agricultural', pitches: 10 }, plan: p });
  const kept = [
    row('Coastal plot Nazare', 20000, 2.7, 12, plan('fits', 'fits every criterion', 21160, ['sea 2.7 km: inside the 20 km e-bike ride'])),
    row('Inland plot Tomar', 5000, 32, 12, plan('trade-off', 'trade-off with potential: lake or reservoir 1.2 km away', 5290, ['12 workable months'])),
    row('Cheap plot Alenquer', 8500, 13.8, 11, plan('fits', 'fits every criterion', 8993, ['sea 13.8 km: inside the 20 km e-bike ride'])),
  ];
  const opp = (score: number, why: string) => ({ ...plan('unverified', 'to confirm', 15000, []), opportunity: { score, reasons: [why] } });
  const outside = [
    { ...row('Pag plot Croatia', 9000, 1, 7, opp(3, '2 of 4 site checks met')), country: 'Croatia', countryCode: 'HR' },
    { ...row('Vir plot Croatia', 12000, 0.3, 7, opp(7, 'scenic and still open: 54 things to explore, only 1 campsite')), country: 'Croatia', countryCode: 'HR' },
  ];
  const id = 'e2e-plot-table-000001';
  const { results: _results, ...stored } = base;
  const project = { ...stored, id, question: 'E2E plots for glamping near the sea', phase: 'done', brief: { kind: { label: 'plot of land', terms: ['plot'] }, regions: ['PT'], asksSea: true, text: 'Deliver: 3 single plot of land listing pages for sale' }, candidates: { found: 5, kept, outside, keptCount: 2, tiers: { fits: 2, 'trade-off': 1, unverified: 0, blocked: 0 }, toCheck: [], toCheckCount: 0, screened: {}, screenedCount: 0, examples: [], strategy: { label: 'Low-entry glamping', rules: { ebikeKm: { value: 20, source: 'guidance' } }, sources: [{ id: 'pt-park', title: 'Portaria 1320/2008 summary', url: 'https://www.ac-arquitetos.com/post/x', confirmed: 3, quotes: 3 }], foundation: { complete: true, missing: [], clauses: [{ text: '10 month a year', criteria: ['season'] }], criteria: [{ id: 'season', label: 'workable months a year', measure: 'Open-Meteo daily weather 2021–2025' }] } } } };
  await fs.writeFile(path.join(process.env.FRL_E2E_DATA_DIR!, `${id}.json`), JSON.stringify(project));
  await page.goto(`/#p=${id}`);
  await page.locator('.tabs .tab', { hasText: 'Results' }).click();
  const table = page.locator('#candRows');
  await expect(table).toContainText('Coastal plot Nazare', { timeout: 20000 });
  await expect(page.locator('#candidateTable')).toContainText('every part of your question has a code check');
  await expect(page.locator('#candidateTable')).toContainText('1/1 sources re-read online');
  await table.locator('tr', { hasText: 'Coastal plot Nazare' }).locator('td').first().click();
  const pip = page.locator('#pip');
  await expect(pip).toBeVisible();
  await expect(pip).toContainText('sea 2.7 km: inside the 20 km e-bike ride');
  await expect(pip).toContainText('ask the Câmara');
  await expect(pip.locator('a', { hasText: 'Open the listing' })).toHaveAttribute('href', 'https://imo.example/anuncio/Coastal-plot-Nazare');
  await pip.locator('button[data-pipact="close"]').click();
  await expect(pip).toBeHidden();
  const titles = () => table.locator('tr td:nth-child(4) a').allTextContents();
  expect(await titles()).toEqual(['Coastal plot Nazare', 'Cheap plot Alenquer', 'Inland plot Tomar']);
  await table.locator('th[data-csort="entry"]').click();
  expect(await titles()).toEqual(['Inland plot Tomar', 'Cheap plot Alenquer', 'Coastal plot Nazare']);
  await page.locator('#candRows th[data-csort="entry"]').click();
  expect(await titles()).toEqual(['Coastal plot Nazare', 'Cheap plot Alenquer', 'Inland plot Tomar']);
  await page.locator('#candRows th[data-csort="sea"]').click();
  expect(await titles()).toEqual(['Coastal plot Nazare', 'Cheap plot Alenquer', 'Inland plot Tomar']);
  await page.locator('button[data-ctier="trade-off"]').click();
  expect(await titles()).toEqual(['Inland plot Tomar']);
  await expect(page.locator('#candRows')).toContainText('lake or reservoir 1.2 km away');
  const outTitles = () => page.locator('#outRows tr td:nth-child(3) a').allTextContents();
  await expect(page.locator('#outsideTable')).toContainText('Outside your countries, worth a look');
  expect(await outTitles()).toEqual(['Vir plot Croatia', 'Pag plot Croatia']);
  await expect(page.locator('#outRows')).toContainText('scenic and still open');
  await page.locator('#outRows th[data-csort="price"]').click();
  expect(await outTitles()).toEqual(['Pag plot Croatia', 'Vir plot Croatia']);
  expect(await titles()).toEqual(['Inland plot Tomar']);
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
  await expect(page.locator('#loopStatus')).toBeVisible();
  await expect(page.locator('#loopStatus')).toContainText('Self-improving loop');
  await expect(page.locator('#loopStatus')).toContainText(/left · ends/);
  await expect(page.locator('#btnStop')).toHaveText('■ Stop loop');
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
  test.setTimeout(120000);
  await page.goto('/');
  if (await page.locator('#menuBtn').isVisible()) {
    await page.locator('#menuBtn').click();
    await expect(page.locator('#sidebar')).toHaveClass(/\bon\b/);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('sidebar')!).transform === 'none');
  }
  await page.locator('#btnRouter').click();
  const body = page.locator('#rtBody');
  await expect(page.getByRole('heading', { name: 'Models & router' })).toBeVisible();
  await expect(body.getByRole('radio', { name: 'Maximum capability' })).toHaveAttribute('aria-checked', 'true');
  await expect(body).toContainText('How each kind of call is routed');
  await expect(body).toContainText('Reviews and roll-ups');
  await expect(body.locator('.rt-roles .card', { hasText: 'Deep role' })).toBeVisible();
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
  await body.getByRole('radio', { name: 'Maximum capability' }).click();
  await expect(body.getByRole('radio', { name: 'Maximum capability' })).toHaveAttribute('aria-checked', 'true');
  await body.locator('[data-rsave="groq"]').click();
  await expect(body.locator('[data-rmsg="groq"]')).toContainText('type or paste a value first');
  await body.locator('[data-rrow="groq"] input[type="password"]').fill('gsk_typed_but_not_saved');
  await page.waitForTimeout(8500);
  await expect(body.locator('[data-rrow="groq"] input[type="password"]')).toHaveValue('gsk_typed_but_not_saved');
});

test('share: More → Share explains the one-research link and says when remote access is off', async ({ page }) => {
  await page.goto('/');
  await page.locator('#inQuestion').fill('Which Czech city is best for a small bakery?');
  await page.locator('#inExpected').fill('one city with three reasons');
  await page.getByRole('button', { name: 'Build the tree →' }).click();
  await expect(page.locator('#phasePill')).toContainText('tree-ready', { timeout: 30000 });
  await expect(page.locator('#btnRun')).toHaveText('▶ Run');
  await page.locator('#moreBtn').click();
  await page.locator('#mShare').click();
  const box = page.locator('#shareBox');
  await expect(box).toBeVisible();
  await expect(box).toContainText('They cannot see your other researches, keys, settings or the terminal');
  await expect(box).toContainText('Remote access is off');
  await expect(page.locator('#shareOn')).toBeDisabled();
  await expect(page.locator('#sharedBanner')).toBeHidden();
  await expect(page.locator('#chatScopes [data-scope="app"]')).toHaveCount(1);
  await page.locator('#shareClose').click();
  await expect(box).toBeHidden();
});

test('results: the sortable table is the list, opportunities filter it, and a selected row opens a docked details panel that replaces the right column and collapses', async ({ page }) => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const base = await (await page.request.post('/api/projects', { data: { question: 'E2E base research for the opportunity table', autoRun: false } })).json();
  const checks = (season: boolean | null) => [{ id: 'sea', label: 'sea within 20 km by e-bike', ok: true, detail: 'sea 2 km' }, { id: 'season', label: '10+ camping months', ok: season, detail: season === null ? 'climate not measured yet' : '11 camping months' }];
  const row = (title: string, tier: string, entry: number, proposal: object, season: boolean | null) => ({ title, url: `https://imo.example/anuncio/${title.replace(/\W+/g, '-')}`, price: entry, currency: 'EUR', value: entry, unit: 'EUR', area: 1000, areaUnit: 'm²', place: 'Mira', country: 'Portugal', countryCode: 'PT', site: { coastKm: 2, beachKm: 2, beaches: 2, viewpoints: 3, attractions: 1, reserves: 0, protectedAreas: 0, hikingRoutes: 1, campsites: 1, lodging: 9, climate: { workable: 11, comfortable: 6, hottest: 25, coldest: 9, cci: { optimalDays: 120, hotDays: 0, optimalTrend: 2, monthly: [3, 3.5, 4, 5, 6, 7, 7.5, 7.5, 6.5, 5, 4, 3] } } }, fit: { hpi: 15.1, zoning: 'agricultural' }, plan: { tier, verdict: tier, why: ['sea 2 km: inside the 20 km e-bike ride'], tradeoffs: [], potential: [], risks: ['check RAN/REN with the Câmara'], units: 15, areaM2: 1000, share: season ? 1 : 0.5, entry: { total: entry, price: entry - 3000, tax: 300, taxLabel: 'IMT 5%', tents: 2700, units: 3, excludes: 'permits' }, checks: checks(season), proposal } });
  const fit = (title: string, rank: number, entry: number, confidence = 'measured') => row(title, 'fits', entry, { role: 'primary', opportunity: 'fits', rank, layer: 1, headline: 'Fits all 2 criteria you set', standsOut: rank === 1 ? ['lowest entry cost of the 3'] : [], confirm: [], confidence, confidenceText: confidence === 'confirmed' ? 'confirmed by the external verifier' : 'measured by the app' }, true);
  const kept = [
    row('Mira plot C', 'unverified', 3900, { role: 'secondary', opportunity: 'to-confirm', rank: 1, layer: 1, headline: 'Meets 1 of 2; still to confirm: 10+ camping months', standsOut: [], confirm: ['10+ camping months: climate not measured yet'], confidence: 'partial', confidenceText: 'some criteria are not met or not measured yet' }, null),
    fit('Mira plot B', 2, 6100),
    fit('Mira plot A', 1, 4400, 'confirmed'),
    fit('Mira plot D', 3, 7000),
  ];
  const url = (t: string) => kept.find((r) => r.title === t)!.url;
  const id = 'e2e-opportunity-table-01';
  const { results: _results, ...stored } = base;
  const project = { ...stored, id, question: 'E2E opportunity table', phase: 'done', acceptance: { ...stored.acceptance, itemCount: 50 }, brief: { kind: { label: 'plot of land', terms: ['plot'] }, regions: ['PT'], text: 'Deliver: plots' }, candidates: { found: 4, kept, outside: [], keptCount: 3, tiers: { fits: 3, 'trade-off': 0, unverified: 1, weak: 0, blocked: 0 }, toCheck: [], toCheckCount: 0, screened: {}, screenedCount: 0, examples: [], proposals: { method: 'Pareto layers over the measured values', objectives: [{ id: 'entry', label: 'entry cost', better: 'min' }], sections: [{ id: 'fits', label: 'Fits every criterion', why: 'every criterion you set is measured and met', urls: [url('Mira plot A'), url('Mira plot B'), url('Mira plot D')] }, { id: 'to-confirm', label: 'Could fit once confirmed', why: 'nothing measured fails', urls: [url('Mira plot C')] }], primary: [], secondary: [] } } };
  await fs.writeFile(path.join(process.env.FRL_E2E_DATA_DIR!, `${id}.json`), JSON.stringify(project));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/#p=${id}`);
  await page.locator('.tabs .tab', { hasText: 'Results' }).click();
  await expect(page.locator('#proposals')).toContainText('3 result(s) fit every criterion', { timeout: 20000 });
  await expect(page.locator('#proposals')).toContainText('50 is your target, not a limit');
  const titles = () => page.locator('#candRows tr td:nth-child(4) a').allTextContents();
  expect(await titles()).toEqual(['Mira plot A', 'Mira plot B', 'Mira plot D', 'Mira plot C']);
  await page.locator('button[data-copp="to-confirm"]').click();
  expect(await titles()).toEqual(['Mira plot C']);
  await expect(page.locator('#proposals')).toContainText('Why this opportunity: nothing measured fails');
  await page.locator('button[data-copp="all"]').click();
  await page.locator('#candRows tr', { hasText: 'Mira plot A' }).locator('td').first().click();
  const pip = page.locator('#pip');
  await expect(pip).toContainText('confirmed by the external verifier');
  await expect(pip).toContainText('lowest entry cost of the 3');
  await expect(pip.locator('.bars i')).toHaveCount(12);
  await expect(page.locator('#inspector')).toBeHidden();
  const docked = (await pip.boundingBox())!;
  expect(Math.round(docked.x + docked.width)).toBe(1400);
  expect(docked.width).toBeGreaterThan(300);
  expect(docked.width).toBeLessThanOrEqual(1400 * 0.34 + 1);
  await pip.locator('button[data-pipact="next"]').click();
  await expect(pip.locator('.pip-head')).toContainText('Mira plot B');
  await expect(page.locator('#candRows tr.on')).toContainText('Mira plot B');
  await pip.locator('.pip-head button[data-pipact="toggle"]').click();
  await expect(pip.locator('.pip-rail')).toBeVisible();
  await expect(page.locator('#inspector')).toBeHidden();
  await pip.locator('.pip-rail').click();
  await expect(pip.locator('.pip-body')).toBeVisible();
  await expect(page.locator('#inspector')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 800 });
  await pip.locator('.pip-head button[data-pipact="toggle"]').click();
  await expect(pip.locator('.pip-body')).toBeHidden();
  await page.locator('#candRows tr', { hasText: 'Mira plot C' }).locator('td').first().click();
  await expect(pip).toContainText('still to confirm: 10+ camping months');
  const sheet = (await pip.boundingBox())!;
  expect(Math.round(sheet.width)).toBe(390);
  expect(Math.round(sheet.y + sheet.height)).toBe(800);
  await pip.locator('button[data-pipact="close"]').click();
  await expect(pip).toBeHidden();
});
