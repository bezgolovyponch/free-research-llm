import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_PRESETS, ROUTE_ORDER, SEARCH_KEYS } from './llm/presets.mjs';
import { OpenAICompatibleProvider } from './llm/provider.mjs';
import { ModelRouter } from './llm/router.mjs';
import { ScriptedProvider } from './llm/scripted-provider.mjs';
import { ResearchEngine } from './research/engine.mjs';
import { KEYED_SEARCH_BACKENDS, SearchService, SearxngBackend, WikipediaBackend } from './search/search.mjs';
import { ProjectImprover } from './research/improve.mjs';
import { NodeChat } from './research/chat.mjs';
import { SubIssueSuggester } from './research/suggest.mjs';
import { ExchangeRates } from './research/rates.mjs';
import { EventLog } from './logs.mjs';
import { TempSweeper, describeSweep, sweepHoursFrom } from './housekeeping.mjs';
import { AppChat } from './appchat.mjs';
import { HandoffWriter } from './research/handoff.mjs';
import { appendAppMessage } from './research/notify.mjs';
import { ProjectStore } from './store.mjs';
import { DocsIndex } from './chat/docs.mjs';
import { MediaReader } from './chat/media.mjs';
import { TerminalHub } from './terminal/hub.mjs';
import { ChangeBook } from './changes.mjs';
import { FreeCoder } from './coder/free-coder.mjs';
import { ClaudeCodeCoder } from './coder/claude-code.mjs';
import { ChangeRunner } from './coder/runner.mjs';
import { KeyChecker } from './keycheck.mjs';
import { LinkVerifier, RouterAdmin } from './llm/admin.mjs';
import { KEY_GUIDES, guidesText } from './llm/guides.mjs';
import { accessLinks, lanAddresses } from './service.mjs';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listEnv(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function routeOrderFrom(env) {
  const both = listEnv(env.FRL_PROVIDER_ORDER);
  return {
    fast: listEnv(env.FRL_FAST_ORDER).length ? listEnv(env.FRL_FAST_ORDER) : both.length ? both : ROUTE_ORDER.fast,
    deep: listEnv(env.FRL_DEEP_ORDER).length ? listEnv(env.FRL_DEEP_ORDER) : both.length ? both : ROUTE_ORDER.deep,
  };
}

function modelOverrides(env, preset) {
  const prefix = `FRL_${preset.id.toUpperCase()}`;
  return {
    fast: env[`${prefix}_FAST_MODEL`] || undefined,
    deep: env[`${prefix}_DEEP_MODEL`] || undefined,
    any: (preset.modelEnv && env[preset.modelEnv]) || undefined,
  };
}

export class ProviderFactory {
  constructor({ env, fetchImpl }) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.sessionKeys = new Map();
  }

  order() {
    const only = listEnv(this.env.FRL_PROVIDER_ORDER);
    const ids = only.length ? only : PROVIDER_PRESETS.map((p) => p.id);
    return ids.map((id) => PROVIDER_PRESETS.find((p) => p.id === id)).filter(Boolean);
  }

  build(preset) {
    const apiKey = this.sessionKeys.get(preset.id) || (preset.keyEnv ? this.env[preset.keyEnv] : '') || (preset.optionalKeyEnv ? this.env[preset.optionalKeyEnv] : '') || '';
    const account = this.sessionKeys.get(`${preset.id}:account`) || (preset.accountEnv ? this.env[preset.accountEnv] : '') || '';
    const template = (preset.baseEnv && this.env[preset.baseEnv]) || this.sessionKeys.get(`${preset.id}:url`) || preset.baseURL;
    const baseURL = account ? template.replace('{account}', encodeURIComponent(account)) : template;
    const disabled = Boolean(preset.disableEnv) && this.env[preset.disableEnv] === '0';
    return new OpenAICompatibleProvider({ preset, apiKey, baseURL, disabled, modelOverrides: modelOverrides(this.env, preset), fetchImpl: this.fetchImpl });
  }

  async buildAll() {
    const providers = this.order().map((preset) => this.build(preset));
    await Promise.all(providers.map((p) => p.discover()));
    return providers;
  }

  setSessionKey(providerId, key, baseURL) {
    if (key) this.sessionKeys.set(providerId, key);
    if (!baseURL) return;
    if (/^https?:\/\//.test(baseURL)) this.sessionKeys.set(`${providerId}:url`, baseURL);
    else this.sessionKeys.set(`${providerId}:account`, baseURL);
  }
}


export function buildSearch({ env, fetchImpl }) {
  const backends = KEYED_SEARCH_BACKENDS.filter(([name]) => env[name]).map(([name, Backend]) => new Backend({ apiKey: env[name], fetchImpl }));
  if (env.SEARXNG_URL) backends.push(new SearxngBackend({ baseURL: env.SEARXNG_URL, fetchImpl }));
  if (env.FRL_WIKIPEDIA !== '0') backends.push(new WikipediaBackend({ fetchImpl, lang: env.FRL_WIKIPEDIA_LANG || 'en' }));
  return new SearchService({ backends, fetchImpl, fetchPages: env.FRL_FETCH_PAGES !== '0', jinaReader: env.FRL_JINA_READER !== '0', jinaKey: env.JINA_API_KEY || '' });
}

const HISTORY_EVENT = /^(created|report|acceptance|improve-state|error):|^phase:(done|stopped|tree ready)/;
const RUNNING_PHASES = new Set(['decomposing', 'researching', 'synthesizing']);
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function appNoteFor(event, project) {
  const q = String(project?.question ?? event.projectId ?? '').slice(0, 110);
  const tail = project ? ` · ${(project.nodes ?? []).filter((n) => ['verified', 'supported'].includes(n.status)).length}/${(project.nodes ?? []).length} pieces pass` : '';
  if (event.type === 'created') return `New research: ${q}`;
  if (event.type === 'improve-state' && /loop (started|ended)/.test(event.message)) return `${event.message[0].toUpperCase()}${event.message.slice(1)} — ${q}`;
  if (event.type === 'phase' && event.message === 'done') return `Research finished — ${q}${tail}`;
  if (event.type === 'error') return `Research error — ${q}: ${String(event.message).slice(0, 200)}`;
  return null;
}

export class App {
  constructor({ env = process.env, fetchImpl = fetch, dataDir, logDir, providers, search, secrets = null } = {}) {
    this.secrets = secrets;
    this.dataDir = dataDir ?? path.join(ROOT_DIR, 'data');
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.sessionSearchEnv = {};
    this.demo = env.FRL_DEMO === '1';
    this.factory = new ProviderFactory({ env, fetchImpl });
    this.logs = new EventLog({ dir: logDir ?? path.join(dataDir ?? path.join(ROOT_DIR, 'data'), 'logs') });
    this.router = new ModelRouter({ providers: providers ?? [], routeOrder: routeOrderFrom(env), onLedger: (row) => this.logs.append('model-calls', row) });
    this.search = search ?? buildSearch({ env, fetchImpl });
    this.store = new ProjectStore({ dir: dataDir ?? path.join(ROOT_DIR, 'data', 'projects'), isBusy: (id) => Boolean(this.engine?.running.has(id) || this.improver?.isActive(id)) });
    this.handoffs = new HandoffWriter({ dir: path.join(dataDir ?? path.join(ROOT_DIR, 'data'), 'handoff') });
    const rates = new ExchangeRates({ fetchImpl });
    this.engine = new ResearchEngine({ router: this.router, search: this.search, store: this.store, demo: this.demo, rates, onEvent: (projectId, event, project) => this.recordEvent(projectId, event, project), onStop: (project, options) => this.saveHandoff(project, options) });
    this.improver = new ProjectImprover({ engine: this.engine });
    this.suggester = new SubIssueSuggester({ engine: this.engine });
    this.port = Number(env.PORT || 4600);
    this.remote = false;
    this.media = new MediaReader({ router: this.router });
    this.docs = new DocsIndex({ root: ROOT_DIR });
    this.terminal = new TerminalHub({ cwd: ROOT_DIR, env, enabled: env.FRL_TERMINAL !== '0' });
    this.routerAdmin = new RouterAdmin({
      env,
      secrets,
      reload: () => this.reloadKeys(),
      statuses: () => this.router.status(),
      ledger: () => this.router.ledger,
      history: () => this.logs.read('model-calls', 20000),
      applyOrder: (order) => {
        const forced = routeOrderFrom(this.env);
        this.router.routeOrder = { fast: this.env.FRL_FAST_ORDER ? forced.fast : order.fast, deep: this.env.FRL_DEEP_ORDER ? forced.deep : order.deep, ...(order.byPurpose && !this.env.FRL_FAST_ORDER && !this.env.FRL_DEEP_ORDER ? { byPurpose: order.byPurpose } : {}) };
      },
      checker: new KeyChecker({ fetchImpl }),
      links: new LinkVerifier({ fetchImpl }),
    });
    this.changes = new ChangeBook({ dir: path.join(dataDir ?? path.join(ROOT_DIR, 'data'), 'changes') });
    const workDir = path.join(dataDir ?? path.join(ROOT_DIR, 'data'), 'work');
    const restart = () => this.restartForCode(env);
    this.freeCoder = new FreeCoder({ router: this.router, root: ROOT_DIR, workDir, changes: this.changes, note: (m) => this.noteApp(m), restart });
    this.claudeCoder = new ClaudeCodeCoder({ root: ROOT_DIR, workDir, changes: this.changes, note: (m) => this.noteApp(m), restart });
    this.coder = new ChangeRunner({ coders: { free: this.freeCoder, claude: this.claudeCoder }, changes: this.changes });
    this.appChat = new AppChat({
      changes: this.changes,
      coder: this.coder,
      engine: this.engine,
      improver: this.improver,
      router: this.router,
      docs: this.docs,
      media: this.media,
      facts: () => this.facts(),
      file: path.join(dataDir ?? path.join(ROOT_DIR, 'data'), 'chat', 'app-chat.json'),
      statusOf: () => ({ models: this.router.status().filter((p) => p.state === 'ready').map((p) => p.id), search: this.search.describe().backends, improving: [...this.improver.active.keys()] }),
    });
    this.chat = new NodeChat({ engine: this.engine, suggester: this.suggester, improver: this.improver, appChat: this.appChat, media: this.media });
    this.fixedProviders = Boolean(providers);
    this.sweeper = new TempSweeper({
      dataDir: this.dataDir,
      logs: this.logs,
      projectExists: (id) => this.projectFileExists(id),
    });
  }

  async projectFileExists(id) {
    try {
      await fs.access(this.store.file(id));
      return true;
    } catch (error) {
      return /invalid project id/.test(error.message);
    }
  }

  startHousekeeping() {
    this.sweeper.schedule(sweepHoursFrom(this.env), (report) => {
      const message = describeSweep(report);
      if (message) void this.logs.append('history', { type: 'session', message });
    });
  }

  async saveHandoff(project, { reason, resume = {} } = {}) {
    const record = await this.handoffs.write(project, { reason, resume });
    appendAppMessage(project, `Progress saved (${reason}). ${record.progress.passing}/${record.progress.total} pieces pass${record.expectedResult ? `, expected result ${Math.round(record.expectedResult.score * 100)}% met` : ''}. Next: ${record.nextSteps[0] ?? 'nothing pending'}. Full handoff: More → Handoff notes.`);
    void this.logs.append('history', { projectId: project.id, type: 'handoff', message: `${reason} · ${record.progress.passing}/${record.progress.total} passing${record.resume.loopHoursLeft ? ` · loop resumes with ${record.resume.loopHoursLeft.toFixed(1)} h` : record.resume.wasRunning ? ' · run resumes on start' : ''}` });
    return record;
  }

  async shutdown() {
    this.sweeper.stop();
    this.terminal.closeAll();
    await this.improver.shutdown();
    for (const id of [...this.engine.running]) {
      if (this.improver.isActive(id)) continue;
      this.engine.cancel(id);
      try {
        const project = await this.engine.load(id);
        await this.saveHandoff(project, { reason: 'app stopped', resume: { wasRunning: true } });
        await this.store.save(project);
      } catch {
        continue;
      }
    }
    await this.logs.queue;
  }

  async resumeInterrupted() {
    const resumed = [];
    for (const record of await this.handoffs.resumable()) {
      try {
        const project = await this.engine.load(record.projectId);
        if (record.resume.loopHoursLeft > 0.05) this.improver.start(project.id, { hours: record.resume.loopHoursLeft, nodes: record.resume.loopScope ?? [], exclude: record.resume.loopExclude ?? [] });
        else this.engine.start(project.id);
        await this.handoffs.clearResume(project.id);
        resumed.push(project.id);
        void this.logs.append('history', { projectId: project.id, type: 'session', message: record.resume.loopHoursLeft > 0.05 ? `loop resumed after restart (${record.resume.loopHoursLeft.toFixed(1)} h)` : 'research run resumed after restart' });
        this.noteApp(`Resumed after restart: ${String(project.question).slice(0, 110)}`);
      } catch {
        continue;
      }
    }
    return resumed;
  }

  async facts() {
    const claude = this.claudeCoder?.available?.() ?? { installed: false, version: '' };
    return {
      platform: PLATFORM_NAMES[process.platform] ?? process.platform,
      local: `http://127.0.0.1:${this.port}`,
      remote: this.remote,
      links: this.remote ? accessLinks({ port: this.port, lan: lanAddresses(os.networkInterfaces()) }).slice(1) : [],
      terminal: { full: 'on (real shell)', basic: 'on (basic shell: node-pty missing)', off: 'off (FRL_TERMINAL=0)' }[await this.terminal.mode()],
      keyGuides: guidesText(Object.keys(KEY_GUIDES).filter((name) => !this.env[name])),
      claude: claude.installed ? `installed (${claude.version})` : 'not installed',
      coders: this.coder?.engines?.() ?? [],
    };
  }

  restartForCode(env) {
    if (env.FRL_SUPERVISED !== '1' || !this.onRestart) return false;
    setTimeout(() => this.onRestart(), 1500);
    return true;
  }

  noteApp(content) {
    void (async () => {
      try {
        await this.appChat.note(content);
      } catch {
        return;
      }
    })();
  }

  recordEvent(projectId, event, project = null) {
    void this.logs.append(`project-${projectId}`, event);
    if (HISTORY_EVENT.test(`${event.type}:${event.message}`)) void this.logs.append('history', { projectId, type: event.type, message: event.message });
    const note = appNoteFor({ ...event, projectId }, project);
    if (note) this.noteApp(note);
  }

  async settleStale() {
    const settled = [];
    for (const p of await this.store.list()) {
      if (!RUNNING_PHASES.has(p.phase) || this.engine.running.has(p.id) || this.improver.isActive(p.id)) continue;
      try {
        const project = await this.engine.load(p.id);
        project.phase = 'cancelled';
        this.engine.emit(project, 'phase', 'cancelled (the app stopped while it ran; press Run to continue)');
        await this.store.save(project);
        settled.push(p.id);
      } catch {
        continue;
      }
    }
    return settled;
  }

  async history() {
    const [sessions, projects] = await Promise.all([this.logs.read('history', 1000), this.store.list()]);
    return { events: sessions.reverse(), projects };
  }

  async refreshProviders() {
    if (this.fixedProviders) return this.router.status();
    const providers = await this.factory.buildAll();
    const live = providers.filter((p) => p.ready);
    if (this.demo && !live.length) providers.push(new ScriptedProvider());
    this.engine.demo = this.demo && !live.length;
    this.router.setProviders(providers);
    this.routerAdmin?.apply();
    return this.router.status();
  }

  async seedLedger() {
    const rows = await this.logs.read('model-calls', 500).catch(() => []);
    if (!this.router.ledger.length) this.router.ledger.push(...rows.slice(-500));
    const benched = this.router.restoreCooldowns(rows);
    if (benched.length) void this.logs.append('history', { type: 'session', message: `still benched after restart (credit, key or daily quota): ${benched.join(', ')}` });
    return this.routerAdmin.apply();
  }

  async reloadKeys() {
    const changed = this.secrets ? await this.secrets.refresh(this.env) : [];
    this.search = buildSearch({ env: { ...this.env, ...this.sessionSearchEnv }, fetchImpl: this.fetchImpl });
    this.engine.search = this.search;
    this.factory.env = this.env;
    await this.refreshProviders();
    void this.logs.append('history', { type: 'session', message: `keys reloaded${changed.length ? `: ${changed.join(', ')}` : ' (no change)'} · search: ${this.search.describe().backends.join(', ')}` });
    this.noteApp(`Keys reloaded${changed.length ? `: ${changed.join(', ')}` : ' (no change)'} · models: ${this.router.status().filter((p) => p.state === 'ready').map((p) => p.id).join(', ') || 'none'} · search: ${this.search.describe().backends.join(', ')}`);
    return { changed, status: this.status() };
  }

  async setKey(providerId, key, baseURL) {
    if (SEARCH_KEYS.some((k) => k.env === providerId)) {
      this.sessionSearchEnv[providerId] = String(key ?? '').trim();
      this.search = buildSearch({ env: { ...this.env, ...this.sessionSearchEnv }, fetchImpl: this.fetchImpl });
      this.engine.search = this.search;
      return this.router.status();
    }
    this.factory.setSessionKey(providerId, String(key ?? '').trim(), String(baseURL ?? '').trim());
    return this.refreshProviders();
  }

  status() {
    return {
      ready: this.router.ready,
      demo: this.engine.demo,
      providers: this.router.status(),
      route: this.router.route(),
      searchKeys: SEARCH_KEYS.map((k) => ({ ...k, set: Boolean(this.env[k.env] || this.sessionSearchEnv[k.env]) })),
      guides: KEY_GUIDES,
      search: this.search.describe(),
      ledger: this.router.ledger.slice(-40),
      calls: this.router.calls,
      improving: [...this.improver.active.keys()],
      improveAll: this.improver.allStatus(),
      coders: this.coder?.engines?.() ?? [],
    };
  }
}
