import { describeProfile, parseCsv, profileTable } from '../data/csv.mjs';
import { htmlToText } from '../search/html.mjs';
import { followUpQueries, mergeSources } from './followup.mjs';
import { appendAppMessage, runSummary } from './notify.mjs';
import { AcceptanceChecker, collectDeliverables, normalizeAcceptance } from './acceptance.mjs';
import { critiquePrompt, decomposePrompt, expandPrompt, researchPrompt, rollupPrompt, synthesizePrompt, withGuidance, GUIDANCE_LIMIT } from './prompts.mjs';
import { templateById, suggestTemplate } from './templates.mjs';
import { ROOT_ID, blankNode, childrenOf, isLeaf, normalizeTree, prerequisitesOf, progress, researchOrder, urlList } from './tree.mjs';
import { needsEscalation, verifyFinding } from './verify.mjs';
import { evaluateAll } from './specs.mjs';
import { provisionalVerdict, resultStatus } from './gaps.mjs';
import { droppedNote, groundAcceptance, groundSpec } from './grounding.mjs';
import { NO_ITEMS_DETAIL, asksForItems } from './deliverable.mjs';
import { harvestItems } from './harvest.mjs';
import { buildBrief, describeBrief, onConcept } from './brief.mjs';
import { buildCandidates, candidateDeliverables, shortlistText, tableVerdict } from './candidates.mjs';
import { checkMemoClaims, claimNote } from './memocheck.mjs';
import { applyStrategy, foundationOf, foundationText, StrategyRetriever, strategyFor } from './strategy.mjs';
import { applyModel, modelText, verifyKind, withModelRules } from './decision.mjs';
import { applyVerification, fitsSignature, readVerification } from './verification.mjs';
import { CandidateSweeper } from './sweep.mjs';
import { diverseOrder, evidenceQuery, retrievalVerdict, selectEvidence } from './evidence.mjs';
import { compactProject, compactSources } from './compact.mjs';
import { screenItems } from './itemgate.mjs';
import { DEFAULT_LANES, MAX_LANES, runInLanes } from './lanes.mjs';
import { BLOCKING, auditFeedback, auditTree, cleanTitle, duplicateAmong, duplicateOf, modelOf, repairTree } from './treeaudit.mjs';
import { basisOf, weakReason, effectiveGrade, nodeIdsIn, questionKind, sanitizeVerdict } from './result.mjs';
import { entityDomains, entityNames, entityQueries, hostOf, mentionedNames, ownerOnly, scopedQueries, terms } from '../search/selection.mjs';

const CONFIDENCE = ['low', 'medium', 'high'];
const DONE = new Set(['verified', 'supported', 'weak', 'unsupported']);
const GRADE_RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0 };
const LOG_LIMIT = 300;
const MAX_ATTEMPTS = 3;
const MAX_ATTACHMENTS = 6;
const ATTACHMENT_TEXT_LIMIT = 20000;
const ATTACHMENT_TYPES = /\.(csv|tsv|txt|md|json|html?)$/i;
const SWEEP_PAGES_KEPT = 120;
export const TEAM_TTL_MS = 24 * 3600 * 1000;

export class ProjectBusyError extends Error {}
export class NotFoundError extends Error {}

function strings(value, max = 8) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean).slice(0, max);
}

export function normalizeFinding(raw) {
  const claims = (Array.isArray(raw?.claims) ? raw.claims : []).slice(0, 12).map((c) => ({
    text: String(c?.text ?? '').slice(0, 400),
    value: c?.value ?? null,
    unit: String(c?.unit ?? ''),
    sourceIds: strings(c?.sourceIds ?? c?.sources, 6).map((s) => s.replace(/[[\]]/g, '')),
    quote: String(c?.quote ?? '').slice(0, 400),
    assumption: Boolean(c?.assumption),
  })).filter((c) => c.text);
  const calc = raw?.calculation && raw.calculation.formula ? {
    formula: String(raw.calculation.formula).slice(0, 300),
    inputs: raw.calculation.inputs && typeof raw.calculation.inputs === 'object' ? raw.calculation.inputs : {},
    result: raw.calculation.result,
    unit: String(raw.calculation.unit ?? ''),
  } : null;
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, 20).map((i) => ({
    title: String(i?.title ?? '').slice(0, 160),
    url: String(i?.url ?? '').trim().slice(0, 500),
    value: i?.value ?? null,
    unit: String(i?.unit ?? '').slice(0, 20),
    sourceId: String(i?.sourceId ?? '').replace(/[[\]]/g, ''),
  })).filter((i) => /^https?:\/\//.test(i.url));
  return {
    answer: String(raw?.answer ?? '').slice(0, 1200),
    reasoning: String(raw?.reasoning ?? '').slice(0, 800),
    claims,
    items,
    calculation: calc,
    confidence: CONFIDENCE.includes(raw?.confidence) ? raw.confidence : 'low',
    assumptions: strings(raw?.assumptions),
    gaps: strings(raw?.gaps),
  };
}

function normalizeCritique(raw) {
  if (!raw) return null;
  return {
    agree: raw.agree !== false,
    severity: ['none', 'minor', 'major'].includes(raw.severity) ? raw.severity : 'none',
    issues: strings(raw.issues, 6),
    betterAnswer: String(raw.betterAnswer ?? '').slice(0, 600),
  };
}

function keyNumbers(finding) {
  return (finding?.claims ?? []).filter((c) => /\d/.test(c.text)).slice(0, 3).map((c) => c.text).join('; ');
}

export function normalizeEstimate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const field = (v) => String(v ?? '').trim().slice(0, 120);
  const e = { value: field(raw.value), unit: field(raw.unit), low: field(raw.low), high: field(raw.high), basis: field(raw.basis) };
  return e.value ? e : null;
}

export class ResearchEngine {
  constructor({ router, search, store, demo = false, rates = null, sites = null, lanes = DEFAULT_LANES, onEvent = () => {}, onStop = async () => {}, verifier = null, modeler = null, cases = null, arms = null }) {
    this.verifier = verifier;
    this.modeler = modeler;
    this.cases = cases;
    this.arms = arms;
    this.verifying = new Map();
    this.onStop = onStop;
    this.laneCount = Math.min(MAX_LANES, Math.max(1, lanes));
    this.helpers = new Map();
    this.quiet = new Set();
    this.router = router;
    this.search = search;
    this.store = store;
    this.demo = demo;
    this.rates = rates;
    this.sites = sites;
    this.siteWarm = new Map();
    this.onEvent = onEvent;
    this.listeners = new Map();
    this.running = new Set();
    this.cancelled = new Set();
  }

  subscribe(projectId, listener) {
    if (!this.listeners.has(projectId)) this.listeners.set(projectId, new Set());
    this.listeners.get(projectId).add(listener);
    return () => this.listeners.get(projectId)?.delete(listener);
  }

  emit(project, type, message, extra = {}) {
    const event = { ts: new Date().toISOString(), type, message, ...extra };
    project.log = [...(project.log ?? []), event].slice(-LOG_LIMIT);
    this.onEvent(project.id, event, project);
    for (const listener of this.listeners.get(project.id) ?? []) listener(event, project);
  }

  async load(id) {
    const project = await this.store.get(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    return project;
  }

  async createProject({ question, templateId, constraints = {}, csvText = '', csvName = '', expected = '' }) {
    const q = String(question ?? '').trim();
    if (q.length < 8) throw new Error('describe the question in at least one full sentence');
    const chosen = templateId && templateId !== 'auto' ? templateId : suggestTemplate(q);
    const project = {
      id: this.store.newId(q),
      question: q,
      templateId: templateById(chosen).id,
      constraints,
      createdAt: new Date().toISOString(),
      phase: 'created',
      demo: this.demo,
      decision: '',
      successCriteria: '',
      assumptionsToConfirm: [],
      acceptance: normalizeAcceptance({}, expected),
      acceptanceResult: null,
      nodes: [],
      data: null,
      report: null,
      log: [],
    };
    if (String(csvText).trim()) {
      const table = parseCsv(csvText);
      const profile = profileTable(table);
      project.data = { id: 'D1', kind: 'data', title: csvName || 'uploaded data', url: '', domain: 'user-data', text: describeProfile(profile, csvName || 'uploaded data'), profile };
    }
    this.emit(project, 'created', `project created (template: ${templateById(project.templateId).label})`);
    return this.store.save(project);
  }

  dataSources(project, node = null) {
    return [...(project.data ? [project.data] : []), ...(node?.attachments ?? []).map((a) => ({ id: a.id, kind: 'data', title: `your file: ${a.name}${a.readBy ? ` (read by ${a.readBy})` : ''}`, url: '', domain: 'user-file', snippet: a.text.slice(0, 300), text: a.text, provider: 'upload' }))];
  }

  async addAttachment(id, nodeId, { name = '', text = '', readBy = '' } = {}) {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before adding files');
    const project = await this.load(id);
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError(`node ${nodeId} not found`);
    const fileName = String(name).trim().slice(0, 120) || 'file.txt';
    if (!readBy && !ATTACHMENT_TYPES.test(fileName)) throw new Error('attach a text file: CSV, TSV, TXT, MD, JSON or HTML (for a PDF, export or paste its text first)');
    const raw = String(text);
    if (!raw.trim()) throw new Error('the file is empty');
    node.attachments = node.attachments ?? [];
    if (node.attachments.length >= MAX_ATTACHMENTS) throw new Error(`a piece can hold ${MAX_ATTACHMENTS} files; remove one first`);
    const isTable = !readBy && /\.(csv|tsv)$/i.test(fileName);
    const body = readBy ? raw : isTable ? describeProfile(profileTable(parseCsv(raw)), fileName) : /\.html?$/i.test(fileName) ? htmlToText(raw) : raw;
    let n = 1;
    while (node.attachments.some((a) => a.id === `U${n}`)) n++;
    node.attachments.push({ id: `U${n}`, name: fileName, size: raw.length, kind: readBy ? 'read' : isTable ? 'table' : 'text', ...(readBy ? { readBy } : {}), text: body.slice(0, ATTACHMENT_TEXT_LIMIT), truncated: body.length > ATTACHMENT_TEXT_LIMIT, addedAt: new Date().toISOString() });
    this.resetWithAncestors(project, nodeId);
    this.emit(project, 'edit', `${nodeId}: file "${fileName}" attached as source U${n}`, { nodeId });
    return this.store.save(project);
  }

  async removeAttachment(id, nodeId, attachmentId) {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before removing files');
    const project = await this.load(id);
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError(`node ${nodeId} not found`);
    const before = (node.attachments ?? []).length;
    node.attachments = (node.attachments ?? []).filter((a) => a.id !== attachmentId);
    if (node.attachments.length === before) throw new NotFoundError(`file ${attachmentId} not found`);
    this.resetWithAncestors(project, nodeId);
    this.emit(project, 'edit', `${nodeId}: file ${attachmentId} removed`, { nodeId });
    return this.store.save(project);
  }

  async decompose(project) {
    project.phase = 'decomposing';
    this.emit(project, 'phase', 'decomposing the question into an issue tree');
    await this.store.save(project);
    const template = templateById(project.templateId);
    await this.ensureDecisionModel(project);
    const ask = async (feedback) => {
      const reply = await this.router.complete({
        purpose: 'decompose',
        tier: 'deep',
        messages: withGuidance(decomposePrompt({ question: project.question, template, constraints: project.constraints, dataSummary: project.data?.text, expected: project.acceptance?.expected, brief: this.briefOf(project).text, feedback }), project.guidance),
      });
      const tree = normalizeTree(reply.data, project.question);
      repairTree(tree.nodes, project.question, modelOf({ ...project, brief: this.briefOf(project) }));
      return { reply, tree, issues: auditTree(tree.nodes, project.question, modelOf({ ...project, brief: this.briefOf(project) })) };
    };
    let { reply, tree, issues } = await ask('');
    if (issues.some((i) => BLOCKING.has(i.code) || i.code === 'single-child' || i.code === 'misplaced')) {
      this.emit(project, 'tree', `tree checks failed (${issues.map((i) => i.code).join(', ')}); asking for a corrected tree`);
      const second = await ask(auditFeedback(issues)).catch(() => null);
      if (second && second.tree.nodes.length >= 2 && second.issues.length < issues.length) ({ reply, tree, issues } = second);
    }
    if (tree.nodes.length < 2) throw new Error('the model returned an empty issue tree; try again or use a stronger model');
    const proposed = project.acceptance?.locked ? { spec: project.acceptance, dropped: [] } : groundAcceptance(normalizeAcceptance(reply.data?.acceptance, project.acceptance?.expected), { expected: project.acceptance?.expected, question: project.question, constraints: project.constraints });
    const acceptance = proposed.spec;
    if (proposed.dropped.length) this.emit(project, 'acceptance', `expected-result checks ${droppedNote(proposed.dropped)}`);
    Object.assign(project, { decision: tree.decision, successCriteria: tree.successCriteria, assumptionsToConfirm: tree.assumptionsToConfirm, nodes: tree.nodes, acceptance });
    this.emit(project, 'tree', `issue tree ready: ${tree.nodes.length} nodes (${reply.provider}/${reply.model})`);
    await this.store.save(project);
  }

  async buildTree(id) {
    if (this.running.has(id)) throw new ProjectBusyError('this project is already running');
    this.running.add(id);
    try {
      const project = await this.load(id);
      if (!project.nodes.length) await this.decompose(project);
      project.phase = 'tree-ready';
      this.emit(project, 'phase', 'tree ready — review it, then press Run or start the self-improving loop');
      return await this.store.save(project);
    } finally {
      this.running.delete(id);
    }
  }

  briefOf(project) {
    const template = templateById(project.templateId);
    const model = project.decisionModel ?? null;
    const kind = template.itemKind ?? (model?.kind?.terms?.length ? { label: model.kind.label, terms: model.kind.terms } : null);
    const brief = buildBrief({ question: project.question, acceptance: project.acceptance, constraints: project.constraints, template: { ...template, itemKind: kind } });
    const strategy = brief.kind ? strategyFor(project.templateId) : null;
    const foundation = strategy ? withModelRules(foundationOf(strategy, project), model) : null;
    project.brief = { ...brief, foundation, text: [describeBrief(brief), strategy ? foundationText(foundation) : modelText(model)].filter(Boolean).join('\n') };
    return project.brief;
  }

  async ensureDecisionModel(project) {
    if (!this.modeler || this.demo || !project.acceptance?.itemCount || this.modeler.fresh(project)) return project.decisionModel ?? null;
    try {
      const model = await this.modeler.build(project);
      if (model) this.emit(project, 'decision', `decision model: ${model.criteria.length} criteria kept by ${model.agreement.majority} of ${model.agreement.samples} independent proposals (${model.criteria.map((c) => `${c.measure} ${c.op} ${c.value} from ${c.source}`).join('; ') || 'none'})${model.noLimit.length ? `; asked without a limit: ${model.noLimit.map((c) => c.measure).join(', ')}` : ''}${model.missing.length ? `; not modelled: ${model.missing.length} clause(s)` : ''}${model.caseIds.length ? `; examples: ${model.caseIds.join(', ')}` : ''}`);
      return model;
    } catch (error) {
      this.emit(project, 'decision', `decision model not built: ${String(error.message).slice(0, 160)}`);
      return project.decisionModel ?? null;
    }
  }

  onConceptOnly(project, node, sources) {
    const brief = project.brief ?? this.briefOf(project);
    const kept = sources.filter((s) => onConcept(s, brief));
    const dropped = sources.length - kept.length;
    if (dropped) this.emit(project, 'node', `${node.id}: ${dropped} source(s) dropped before any model call — outside the asked regions (${sources.filter((s) => !kept.includes(s)).map((s) => hostOf(s.url)).slice(0, 5).join(', ')})`, { nodeId: node.id });
    return kept;
  }

  async collectCandidates(project, { sweep = false } = {}) {
    if (sweep || !this.quiet.has(project.id)) await this.ensureDecisionModel(project);
    const brief = this.briefOf(project);
    if (!brief.kind) {
      project.candidates = null;
      return null;
    }
    const options = await this.itemGateOptions(project);
    const strategy = strategyFor(project.templateId);
    if (strategy && this.search?.readPage && !this.demo && (sweep || !this.quiet.has(project.id))) {
      project.strategyCheck = await new StrategyRetriever({ readPage: (url) => this.search.readPage(url) }).retrieve(strategy, project.strategyCheck ?? null);
      const quoted = strategy.sources.filter((s) => s.quotes.length);
      const confirmed = quoted.filter((s) => project.strategyCheck[s.id]?.confirmed > 0).length;
      this.emit(project, 'candidates', `strategy "${strategy.label}": ${confirmed} of ${quoted.length} sources re-read online with their quotes found (${project.strategyCheck.at})`);
    }
    if (sweep && this.search?.readPage) {
      const sweeper = new CandidateSweeper({ search: this.search, recipes: this.search.recipes ?? null, arms: this.arms });
      const result = await sweeper.sweep(project, brief, options);
      if (result) {
        const fresh = new Set(result.pages.map((page) => page.url));
        const kept = (project.sweep?.pages ?? []).filter((page) => !fresh.has(page.url));
        const pages = [...compactSources(result.pages).sources, ...kept].slice(0, SWEEP_PAGES_KEPT).map((page, i) => ({ ...page, id: `P${i + 1}` }));
        project.sweep = { ...result, pages };
        if (project.decisionModel?.kind) {
          project.decisionModel.kind = verifyKind(project.decisionModel.kind, pages.flatMap((page) => (page.listings ?? []).map((l) => String(l.title ?? ''))));
          const v = project.decisionModel.kind.verified;
          if (v) this.emit(project, 'decision', `item kind "${project.decisionModel.kind.label}": ${v.matched} of ${v.titles} fetched listing titles use its words${project.decisionModel.kind.dropped?.length ? `; words no listing used were dropped: ${project.decisionModel.kind.dropped.join(', ')}` : ''}`);
        }
        const best = (result.arms ?? []).filter((a) => a.listings > 0).slice(0, 3);
        if (result.arms?.length) this.emit(project, 'candidates', `portal order by Thompson sampling on measured yield: ${result.arms.length} portal(s) read, ${result.arms.filter((a) => a.useful).length} gave new listings within the limits${best.length ? ` (best: ${best.map((a) => `${hostOf(a.url)} ${a.listings}`).join(', ')})` : ''}`);
        this.emit(project, 'candidates', `portal sweep: ${result.pagesRead} listing page(s) read by code (budget ${result.budget}), ${result.pages.reduce((n, p) => n + p.listings.length, 0)} new listing(s)`);
      }
    }
    let table = buildCandidates([...project.nodes, { id: 'sweep', sources: project.sweep?.pages ?? [] }], brief, options);
    if (this.sites && !this.demo) {
      const mode = sweep ? 'all' : this.quiet.has(project.id) ? 'cache' : 'budget';
      const raw = table;
      table = await this.sites.apply(table, brief, { mode, readPage: this.search?.readPage ? (url) => this.search.readPage(url) : null });
      const s = table.sites;
      if (s?.pending) this.startSiteWarm(project.id, raw, brief);
      if (s) this.emit(project, 'candidates', `site fit: ${s.assessed} listing(s) measured (sea distance, climate 2021–2025, things to explore within 15 km), ${s.far} farther than an e-bike ride from the sea, ${s.unlocated} without a location, ${s.pending} queued, ${s.failed} failed`);
    }
    if (strategy) {
      table = applyStrategy(table, strategy, { convert: options.convert, retrieved: project.strategyCheck ?? null, foundation: brief.foundation });
      const t = table.tiers;
      this.emit(project, 'candidates', `strategy paths: ${t.fits} fit every criterion, ${t['trade-off']} trade-offs with their potential, ${t.unverified} to confirm, ${t.weak} weak, ${t.blocked} blocked by law`);
    }
    if (!strategy && project.decisionModel?.criteria?.length) {
      table = applyModel(table, project.decisionModel);
      const t = table.tiers;
      this.emit(project, 'candidates', `decision model: ${t.fits} fit every criterion, ${t.unverified} to confirm, ${t.weak} weak`);
    }
    if (strategy && this.verifier) table = applyVerification(table, await readVerification(this.verifier.dir, project.id));
    project.candidates = table;
    if (strategy && this.verifier) this.startVerification(project);
    if (project.report) this.planActions(project);
    const c = project.candidates;
    this.emit(project, 'candidates', `candidate table: ${c.found} found, ${c.keptCount} kept, ${c.toCheckCount} to check, ${c.screenedCount} screened out${Object.keys(c.screened).length ? ` (${Object.entries(c.screened).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
    return c;
  }

  startSiteWarm(id, raw, brief) {
    if (!this.sites?.file || this.siteWarm.get(id)?.running) return;
    const worker = this.sites.worker ? this.sites.worker() : null;
    if (!worker) return;
    const state = { running: true, ready: false, measured: 0 };
    this.siteWarm.set(id, state);
    void (async () => {
      try {
        const out = await worker.apply(raw, brief, { mode: 'all', readPage: this.search?.readPage ? (url) => this.search.readPage(url) : null });
        state.measured = out?.sites?.assessed ?? 0;
        state.pending = out?.sites?.pending ?? 0;
        state.ready = true;
        if (!this.quiet.has(id)) await this.applyWarmed(id);
      } catch (error) {
        state.error = String(error.message).slice(0, 120);
      } finally {
        state.running = false;
      }
    })();
  }

  startVerification(project) {
    const id = project.id;
    const c = project.candidates;
    if (!c?.verification?.pending || this.verifying.get(id)?.running) return;
    const signature = fitsSignature(c);
    if (this.verifying.get(id)?.signature === signature) return;
    const state = { running: true, signature };
    this.verifying.set(id, state);
    this.emit(project, 'candidates', `external verifier started on ${c.verification.pending} plot(s) that fit every check: it re-reads each listing and re-measures it with its own code`);
    void (async () => {
      try {
        await this.verifier.run(id);
        const ready = this.siteWarm.get(id) ?? { running: false, ready: false, measured: 0 };
        this.siteWarm.set(id, { ...ready, ready: true, verified: true });
        if (!this.quiet.has(id)) await this.applyWarmed(id);
      } catch (error) {
        state.error = String(error.message).slice(0, 120);
      } finally {
        state.running = false;
      }
    })();
  }

  takeWarmed(id) {
    const state = this.siteWarm.get(id);
    if (!state?.ready) return null;
    this.siteWarm.delete(id);
    return state;
  }

  async applyWarmed(id) {
    const state = this.takeWarmed(id);
    if (!state) return null;
    await this.sites.reload();
    const project = await this.load(id);
    this.emit(project, 'candidates', state.verified ? 'external verifier finished; table rebuilt: only plots it confirmed count toward the result' : `site fit in the background: ${state.measured} listing(s) measured${state.pending ? `, ${state.pending} still queued` : ''}; table rebuilt from the measurements`);
    await this.collectCandidates(project);
    await this.checkAcceptance(project);
    await this.store.save(project);
    return project;
  }

  entitiesOf(project) {
    const domains = entityDomains(project.question);
    return { domains, names: entityNames(domains), subject: entityNames(domains)[0] ?? null };
  }

  usedDomains(project, node) {
    const used = {};
    for (const n of project.nodes) if (n.id !== node.id) for (const s of n.sources ?? []) if (s.url) used[hostOf(s.url)] = (used[hostOf(s.url)] ?? 0) + 1;
    return used;
  }

  async gatherSources(project, node) {
    const sources = [];
    const entities = this.entitiesOf(project);
    node.ownerOnly = ownerOnly(node, entities.subject ? [entities.subject] : []);
    if (this.search?.enabled && !node.ownerOnly) {
      const direct = [...(node.sourceUrls?.length && this.search.readPages ? await this.search.readPages(node.sourceUrls) : [])];
      const queries = [...new Set([...entityQueries(node, entities.domains), ...scopedQueries(node, entities.names)])];
      const web = await this.search.search(queries, { maxSources: 8 - direct.length, exclude: direct.map((d) => d.url), wanted: terms(`${node.title} ${node.question}`), entities: entities.domains, usedDomains: this.usedDomains(project, node), names: mentionedNames(node, entities.names) });
      this.onConceptOnly(project, node, [...direct, ...web]).forEach((s, i) => sources.push({ ...s, id: `S${i + 1}` }));
      if (!web.length && this.search.lastErrors.length) this.emit(project, 'warn', `${node.id}: search failed (${this.search.lastErrors.join('; ').slice(0, 200)})`, { nodeId: node.id });
    }
    return [...sources, ...this.dataSources(project, node)];
  }

  async searchGaps(project, node) {
    if (!this.search?.enabled || !node.finding) return;
    const queries = followUpQueries(node, node.finding, [...node.searchQueries, ...(node.followUpQueries ?? [])]);
    if (!queries.length) return;
    node.followUpQueries = [...(node.followUpQueries ?? []), ...queries];
    this.emit(project, 'node', `${node.id}: searching the gaps — ${queries.join(' | ').slice(0, 160)}`, { nodeId: node.id });
    const found = this.onConceptOnly(project, node, await this.search.search(queries, { maxSources: 4, exclude: node.sources.map((s) => s.url).filter(Boolean) }));
    const { sources, added } = mergeSources(node.sources, found);
    node.sources = sources;
    this.emit(project, 'node', `${node.id}: ${added.length} new source(s) from gap search`, { nodeId: node.id });
  }

  rankSources(project, node) {
    const ranked = selectEvidence(node.sources ?? [], evidenceQuery(node, project.brief));
    return { verdict: retrievalVerdict(ranked), shown: diverseOrder(ranked) };
  }

  async correctiveSearch(project, node) {
    if (!this.search?.enabled) return;
    const queries = [...new Set([node.question, `${node.title} ${node.metric ?? ''}`.trim()].filter(Boolean))].filter((q) => !(node.searchQueries ?? []).includes(q));
    if (!queries.length) return;
    this.emit(project, 'node', `${node.id}: retrieved pages do not match the question; searching again before any model call`, { nodeId: node.id });
    const found = this.onConceptOnly(project, node, await this.search.search(queries, { maxSources: 4, exclude: node.sources.map((s) => s.url).filter(Boolean) }));
    const { sources, added } = mergeSources(node.sources, found);
    node.sources = sources;
    node.followUpQueries = [...(node.followUpQueries ?? []), ...queries];
    this.emit(project, 'node', `${node.id}: ${added.length} new source(s) from the corrective search`, { nodeId: node.id });
  }

  upstreamFor(project, node) {
    const byId = new Map(project.nodes.map((n) => [n.id, n]));
    return node.dependsOn.map((id) => byId.get(id)).filter((n) => n?.finding).map((n) => ({ id: n.id, status: n.status, answer: n.finding.answer, keyNumbers: keyNumbers(n.finding) }));
  }

  async critique(node, finding, sources, avoid) {
    try {
      const reply = await this.router.complete({ purpose: 'critique', tier: 'fast', avoid, messages: critiquePrompt({ node, finding, sources }) });
      return normalizeCritique(reply.data);
    } catch {
      return null;
    }
  }

  async researchLeaf(project, node, hint) {
    node.status = 'researching';
    this.emit(project, 'node', `${node.id}: searching sources`, { nodeId: node.id });
    node.sources = await this.gatherSources(project, node);
    if (node.ownerOnly && !node.sources.length) {
      const who = node.ownerOnly;
      node.finding = { answer: `Only ${who} has this figure; it is not public. Give it in this piece's chat (request + desired output) or attach your data, and the research uses it.`, claims: [], gaps: [`${who}'s own figure: owner input needed`], assumptions: [], confidence: 'low' };
      node.verification = { grade: 'weak', score: 0, checks: [{ id: 'concrete', label: 'Gives a concrete answer, not "unknown"', passed: false, detail: `needs ${who}'s own data (owner input)` }], failures: [`needs ${who}'s own data (owner input)`] };
      node.status = 'weak';
      this.emit(project, 'node', `${node.id}: not searched — only ${who} has this figure; marked Clarify`, { nodeId: node.id });
      return;
    }
    this.emit(project, 'node', `${node.id}: ${node.sources.length} source(s) from ${new Set(node.sources.filter((x) => x.url).map((x) => hostOf(x.url))).size} site(s), analysing`, { nodeId: node.id });
    let failures = [];
    if (this.rankSources(project, node).verdict === 'incorrect') await this.correctiveSearch(project, node);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const tier = attempt === 1 ? 'fast' : 'deep';
      if (attempt > 1) await this.searchGaps(project, node);
      const { shown } = this.rankSources(project, node);
      const reply = await this.router.complete({
        purpose: 'research',
        tier,
        messages: withGuidance(researchPrompt({ question: project.question, node, sources: shown, upstream: this.upstreamFor(project, node), previousFailures: failures, hint, expected: project.acceptance?.expected, brief: (project.brief ?? this.briefOf(project)).text }), project.guidance),
      });
      const finding = await this.withHarvest(project, node, await this.screenFinding(project, normalizeFinding(reply.data)));
      const mechanical = verifyFinding({ finding, sources: node.sources, node });
      const retryAnyway = needsEscalation(mechanical) && attempt < MAX_ATTEMPTS;
      const critique = retryAnyway ? null : await this.critique(node, finding, shown, reply.provider);
      const verification = retryAnyway ? mechanical : verifyFinding({ finding, sources: node.sources, critique, node });
      Object.assign(node, { finding, critique, verification, attempts: attempt, model: `${reply.provider}/${reply.model}`, status: verification.grade });
      this.router.recordOutcome?.({ provider: reply.provider, purpose: 'research', passed: verification.grade === 'verified' || verification.grade === 'supported' });
      this.emit(project, 'node', `${node.id}: ${verification.grade} (attempt ${attempt}, ${tier} tier, ${reply.provider})`, { nodeId: node.id });
      if (!needsEscalation(verification)) return;
      failures = [...verification.failures, ...(critique?.issues ?? [])];
      if (attempt < MAX_ATTEMPTS) this.emit(project, 'escalate', `${node.id}: checks failed, searching the gaps and escalating to deep tier`, { nodeId: node.id });
    }
  }

  async rollup(project, node) {
    node.status = 'researching';
    const children = childrenOf(project.nodes, node.id);
    this.emit(project, 'node', `${node.id}: combining ${children.length} sub-findings`, { nodeId: node.id });
    const reply = await this.router.complete({ purpose: 'rollup', tier: 'fast', messages: withGuidance(rollupPrompt({ question: project.question, node, children }), project.guidance) });
    const finding = normalizeFinding(reply.data);
    node.sources = children.map((c) => ({ id: c.id, kind: 'node', title: c.title, url: '', domain: `node:${c.id}`, text: c.finding?.answer ?? '' }));
    const verification = verifyFinding({ finding, sources: node.sources, node: { method: 'rollup' } });
    const weakest = Math.min(...children.map((c) => GRADE_RANK[c.status] ?? 0));
    const fromChildren = ['unsupported', 'weak', 'supported', 'verified'][weakest];
    const ownChecksPassed = verification.grade === 'verified' || verification.grade === 'supported';
    const grade = ownChecksPassed ? fromChildren : GRADE_RANK[fromChildren] < GRADE_RANK[verification.grade] ? fromChildren : verification.grade;
    Object.assign(node, { finding, verification: { ...verification, grade, rolledUpFrom: children.map((c) => `${c.id}:${c.status}`) }, attempts: 1, model: `${reply.provider}/${reply.model}`, status: grade });
    this.emit(project, 'node', `${node.id}: ${grade} (rolled up)`, { nodeId: node.id });
  }

  async synthesize(project) {
    project.phase = 'synthesizing';
    this.emit(project, 'phase', 'writing the decision memo');
    await this.store.save(project);
    const template = templateById(project.templateId);
    const reply = await this.router.complete({
      purpose: 'synthesize',
      tier: 'deep',
      messages: withGuidance(synthesizePrompt({ question: project.question, decision: project.decision, successCriteria: project.successCriteria, template, constraints: project.constraints, nodes: project.nodes, expected: project.acceptance?.expected, kind: questionKind(project), shortlist: shortlistText(project.candidates) }), project.guidance),
    });
    const r = reply.data ?? {};
    const counts = progress(project.nodes);
    project.report = {
      verdict: sanitizeVerdict(r.verdict).slice(0, 300),
      modelVerdict: sanitizeVerdict(r.verdict).slice(0, 300),
      kind: questionKind(project),
      confidence: CONFIDENCE.includes(r.confidence) ? r.confidence : 'low',
      summary: String(r.summary ?? '').slice(0, 2500),
      keyNumbers: (Array.isArray(r.keyNumbers) ? r.keyNumbers : []).slice(0, 12),
      scenarios: (Array.isArray(r.scenarios) ? r.scenarios : []).slice(0, 4),
      sensitivity: (Array.isArray(r.sensitivity) ? r.sensitivity : []).slice(0, 8),
      risks: strings(r.risks, 10),
      openQuestions: strings(r.openQuestions, 10),
      nextSteps: (Array.isArray(r.nextSteps) ? r.nextSteps : []).slice(0, 10),
      evidenceQuality: { ...counts, weak: project.nodes.filter((n) => ['weak', 'unsupported', 'failed'].includes(n.status)).map((n) => n.id) },
      bestEstimate: normalizeEstimate(r.bestEstimate),
      actionItems: (Array.isArray(r.actions) ? r.actions : []).slice(0, 12).map((x) => ({ action: String(x?.action ?? '').slice(0, 300), why: String(x?.why ?? '').slice(0, 300), horizon: String(x?.horizon ?? '').slice(0, 60), impact: Math.min(5, Math.max(1, Number(x?.impact) || 3)), nodeIds: nodeIdsIn(x?.nodeIds ?? x) })).filter((x) => x.action),
      options: (Array.isArray(r.options) ? r.options : []).slice(0, 6).map((o) => ({ option: String(o?.option ?? '').slice(0, 160), support: nodeIdsIn(o?.support), against: nodeIdsIn(o?.against) })).filter((o) => o.option),
      basis: basisOf(project.nodes),
      model: `${reply.provider}/${reply.model}`,
      generatedAt: new Date().toISOString(),
    };
    this.planActions(project);
    await this.checkAcceptance(project);
    this.emit(project, 'report', `decision memo ready: ${project.report.verdict}`);
  }

  planActions(project) {
    if (!project.report) return null;
    const status = resultStatus(project);
    const table = tableVerdict(project.candidates, project.acceptance?.itemCount ?? null);
    const said = project.report.modelVerdict ?? project.report.verdict;
    project.report.claimCheck = checkMemoClaims(project.report, project.candidates, { valueRange: project.acceptance?.valueRange ?? null, rules: project.candidates?.strategy?.rules ?? null, itemCount: project.acceptance?.itemCount ?? null });
    const note = claimNote(project.report.claimCheck);
    project.report.verdict = `${provisionalVerdict(table ? `${table} — model memo: ${said}` : said, status).slice(0, 600 - note.length)}${note}`;
    project.report.status = { provisional: status.provisional, coverage: status.coverage, confidence: status.confidence, blocking: status.blocking, counts: status.counts };
    project.report.actions = status.plan.slice(0, 40);
    return status;
  }

  reground(project) {
    const dropped = [];
    if (project.acceptance && !project.acceptance.locked) {
      const grounded = groundAcceptance(project.acceptance, { expected: project.acceptance.expected, question: project.question, constraints: project.constraints });
      if (grounded.dropped.length) {
        project.acceptance = grounded.spec;
        dropped.push(...grounded.dropped);
      }
    }
    for (const holder of [project, ...project.nodes]) {
      if (!holder.specs?.length) continue;
      holder.specs = holder.specs.map((spec) => {
        const grounded = groundSpec(spec, { desired: spec.desired, request: spec.request });
        if (!grounded.dropped.length) return spec;
        dropped.push(...grounded.dropped.map((d) => `${holder.id ?? 'Q'}/${spec.id} ${d}`));
        return grounded.spec;
      });
    }
    if (dropped.length) this.emit(project, 'acceptance', `stored checks ${droppedNote(dropped)}`);
    return dropped.length > 0;
  }

  async itemGateOptions(project) {
    const convert = this.rates ? await this.rates.converter().catch(() => undefined) : undefined;
    return { valueRange: project.acceptance?.valueRange ?? null, unit: project.acceptance?.unit ?? '', kind: templateById(project.templateId)?.itemKind ?? null, ...(convert ? { convert } : {}) };
  }

  async screenFinding(project, finding) {
    if (!finding.items?.length) return finding;
    const { kept, rejected } = screenItems(finding.items, await this.itemGateOptions(project));
    return { ...finding, items: kept, rejected: [...(finding.rejected ?? []), ...rejected].slice(-20) };
  }

  async withHarvest(project, node, finding) {
    if (!asksForItems(node)) return finding;
    const extra = harvestItems({ ...node, finding }, await this.itemGateOptions(project));
    return extra.length ? { ...finding, items: [...(finding.items ?? []), ...extra] } : finding;
  }

  async harvestAll(project) {
    const options = await this.itemGateOptions(project);
    const added = [];
    for (const node of project.nodes) {
      if (!node.finding || !asksForItems(node)) continue;
      const extra = harvestItems(node, options);
      if (!extra.length) continue;
      node.finding = { ...node.finding, items: [...(node.finding.items ?? []), ...extra] };
      added.push(`${node.id} +${extra.length}`);
    }
    if (added.length) this.emit(project, 'edit', `listings taken from pages already read and passed by the item gate: ${added.join(', ')}`);
    return added;
  }

  async rescreenItems(project) {
    const options = await this.itemGateOptions(project);
    const changed = [];
    for (const node of project.nodes) {
      if (!node.finding?.items?.length) continue;
      const { kept, rejected } = screenItems(node.finding.items, options);
      if (!rejected.length) continue;
      node.finding = { ...node.finding, items: kept, rejected: [...(node.finding.rejected ?? []), ...rejected].slice(-20) };
      changed.push(`${node.id} −${rejected.length}`);
    }
    if (changed.length) this.emit(project, 'edit', `item gate removed listings that are not single ${options.kind?.label ?? 'item'} pages within the range: ${changed.join(', ')}`);
    return changed;
  }

  async regroundAndRescore(id, { sweep = false } = {}) {
    const project = await this.load(id);
    const compacted = compactProject(project);
    const fixes = repairTree(project.nodes, project.question, modelOf({ ...project, brief: this.briefOf(project) }));
    if (fixes.length) this.emit(project, 'tree', `tree repaired: ${fixes.map((f) => `${f.nodeId} ${f.code}`).join(', ')}`);
    const regrounded = this.reground(project);
    await this.rescreenItems(project);
    await this.harvestAll(project);
    await this.collectCandidates(project, { sweep });
    const regraded = this.regrade(project);
    if (fixes.some((f) => ['merged-duplicate', 'grouped-candidates'].includes(f.code)) || regraded.length) {
      await this.store.save(project);
      return this.run(id);
    }
    if (project.report) await this.checkAcceptance(project);
    return this.store.save(project);
  }

  async checkAcceptance(project) {
    const fromTable = candidateDeliverables(project.candidates);
    const listed = new Set(fromTable.map((d) => d.url));
    const deliverables = project.candidates ? fromTable : [...fromTable, ...collectDeliverables(project.nodes).filter((d) => !listed.has(d.url))];
    project.report.deliverables = deliverables;
    const convert = this.rates ? await this.rates.converter() : undefined;
    const checker = new AcceptanceChecker({ readPage: this.search?.readPage ? (url) => this.search.readPage(url) : null, convert });
    project.acceptanceResult = await checker.evaluate(project.acceptance, deliverables);
    if (project.acceptanceResult && project.decisionModel) await this.cases?.reward([...(project.decisionModel.caseIds ?? []), project.id], project.acceptanceResult.score);
    if (project.acceptanceResult) this.emit(project, 'acceptance', `expected result: ${Math.round(project.acceptanceResult.score * 100)}% — ${project.acceptanceResult.checks.map((c) => `${c.label} ${Math.round(c.value * 100)}%`).join(' · ')}`);
  }

  checkSpecs(project) {
    const results = evaluateAll(project);
    if (!results.length) return results;
    const failed = results.filter((r) => !r.passed);
    this.emit(project, 'checks', `regression checks: ${results.length - failed.length}/${results.length} pass${failed.length ? ` · failing: ${failed.map((r) => `${r.nodeId}/${r.specId}${r.regressed ? ' (regressed)' : ''}`).join(', ')}` : ''}`);
    return results;
  }

  async run(id, { hints = {}, memo = true, sweep = null } = {}) {
    if (this.running.has(id)) throw new ProjectBusyError('this project is already running');
    this.running.add(id);
    this.cancelled.delete(id);
    let project;
    let released = false;
    const release = () => {
      released = true;
      this.running.delete(id);
      if (!this.quiet.has(id)) this.leave(id);
    };
    try {
      project = await this.load(id);
      if (!this.quiet.has(id)) this.rejoinTeam(id);
      if (!project.nodes.length) await this.decompose(project);
      this.reground(project);
      project.phase = 'researching';
      project.error = null;
      for (const node of project.nodes) if (node.status === 'failed' || node.status === 'researching') node.status = 'pending';
      const compacted = compactProject(project);
      if (compacted) this.emit(project, 'tree', `stored page text and links capped for ${compacted} source(s) to keep memory small`);
      const fixes = repairTree(project.nodes, project.question, modelOf({ ...project, brief: this.briefOf(project) }));
      if (fixes.length) this.emit(project, 'tree', `tree repaired: ${fixes.map((f) => `${f.nodeId} ${f.code}`).join(', ')}`);
      this.regrade(project);
      this.emit(project, 'phase', 'researching sub-questions in dependency order');
      await this.store.save(project);
      const byId = new Map(project.nodes.map((n) => [n.id, n]));
      const finished = (nodeId) => DONE.has(byId.get(nodeId)?.status) || byId.get(nodeId)?.status === 'failed';
      await runInLanes({
        order: researchOrder(project.nodes),
        isFinished: finished,
        prerequisites: (nodeId) => prerequisitesOf(project.nodes, byId.get(nodeId)),
        known: (nodeId) => byId.has(nodeId),
        lanes: () => this.lanesFor(id),
        shouldStop: () => this.cancelled.has(id),
        work: async (nodeId) => {
          const node = byId.get(nodeId);
          if (DONE.has(node.status)) return;
          try {
            if (isLeaf(project.nodes, node)) {
              await this.researchLeaf(project, node, hints[node.id]);
              node.sources = compactSources(node.sources).sources;
            } else await this.rollup(project, node);
          } catch (error) {
            node.status = 'failed';
            node.error = error.message;
            this.emit(project, 'error', `${node.id}: ${error.message}`, { nodeId: node.id });
            if (/no model provider|cooling down/.test(error.message)) throw error;
          }
          await this.store.save(project);
        },
      });
      if (this.cancelled.has(id)) {
        project.phase = 'cancelled';
        release();
        this.emit(project, 'phase', 'stopped by user');
        if (!this.quiet.has(id)) await this.onStop(project, { reason: 'stopped by user' });
        return await this.store.save(project);
      }
      try {
        await this.collectCandidates(project, { sweep: sweep ?? !this.quiet.has(id) });
      } catch (error) {
        this.emit(project, 'warn', `candidate table not built: ${error.message}`);
      }
      if (memo || !project.report) await this.synthesize(project);
      else await this.checkAcceptance(project);
      this.checkSpecs(project);
      project.phase = 'done';
      release();
      this.emit(project, 'phase', 'done');
      appendAppMessage(project, runSummary(project));
      if (!this.quiet.has(id)) await this.onStop(project, { reason: 'research finished' });
      return await this.store.save(project);
    } catch (error) {
      if (project) {
        project.phase = 'error';
        project.error = error.message;
        appendAppMessage(project, `Research stopped with an error: ${error.message}. Press Run to resume; finished nodes are kept.`);
        if (!this.quiet.has(id)) await this.onStop(project, { reason: `error: ${error.message}` }).catch(() => {});
        this.emit(project, 'error', error.message);
        await this.store.save(project);
      }
      throw error;
    } finally {
      if (!released) release();
    }
  }

  lanesFor(id) {
    return Math.min(MAX_LANES, this.laneCount + (this.helpers.get(id)?.size ?? 0));
  }

  teamOf(id) {
    return { lanes: this.lanesFor(id), helpers: [...(this.helpers.get(id) ?? [])] };
  }

  join(id, clientId = '') {
    const team = this.helpers.get(id) ?? new Set();
    const key = String(clientId || `anonymous-${team.size + 1}`).slice(0, 64);
    const already = team.has(key);
    if (!already && this.laneCount + team.size < MAX_LANES) team.add(key);
    this.helpers.set(id, team);
    const project = this.store.cache.get(id);
    if (project && team.has(key)) project.team = { ...(project.team ?? {}), [key]: new Date().toISOString() };
    const lanes = this.lanesFor(id);
    if (project && !already) this.emit(project, 'team', team.has(key) ? `a teammate joined: now ${lanes} lanes work on this research at once` : `a teammate joined; already at the maximum of ${lanes} lanes`);
    return { joined: team.has(key), already, lanes, mine: team.has(key) };
  }

  teammates(project, now = Date.now()) {
    return Object.entries(project?.team ?? {}).filter(([, at]) => now - Date.parse(at) < TEAM_TTL_MS).map(([key]) => key);
  }

  rejoinTeam(id, join = (clientId) => this.join(id, clientId)) {
    const team = this.helpers.get(id) ?? new Set();
    const missing = this.teammates(this.store.cache.get(id)).filter((key) => !team.has(key));
    missing.forEach((key) => join(key));
    return missing;
  }

  leaveOne(id, clientId = '') {
    const team = this.helpers.get(id);
    const removed = Boolean(team?.delete(String(clientId)));
    const project = this.store.cache.get(id);
    if (project?.team?.[clientId]) {
      const { [clientId]: gone, ...rest } = project.team;
      project.team = rest;
    }
    if (project && removed) this.emit(project, 'team', `a teammate left: now ${this.lanesFor(id)} lanes`);
    return { left: removed, lanes: this.lanesFor(id), mine: false };
  }

  leave(id) {
    this.helpers.delete(id);
  }

  start(id, options) {
    void (async () => {
      try {
        await this.run(id, options);
      } catch {
        return;
      }
    })();
  }

  cancel(id) {
    this.cancelled.add(id);
  }

  resetWithAncestors(project, nodeId) {
    const byId = new Map(project.nodes.map((n) => [n.id, n]));
    let cursor = byId.get(nodeId);
    while (cursor) {
      Object.assign(cursor, { status: 'pending', finding: null, verification: null, critique: null, error: null });
      cursor = cursor.parentId === ROOT_ID ? null : byId.get(cursor.parentId);
    }
    for (const n of project.nodes) {
      if (n.dependsOn.includes(nodeId) && n.status !== 'pending') this.resetWithAncestors(project, n.id);
    }
    if (project.phase === 'done') project.phase = 'tree-ready';
  }

  regrade(project) {
    const byId = new Map(project.nodes.map((n) => [n.id, n]));
    const changed = [];
    for (const node of project.nodes) {
      if (!isLeaf(project.nodes, node) || effectiveGrade(node) === node.status) continue;
      const detail = weakReason(node);
      node.status = effectiveGrade(node);
      if (node.verification) {
        node.verification.grade = node.status;
        node.verification.failures = [...new Set([...(node.verification.failures ?? []), detail])];
        node.verification.checks = [...(node.verification.checks ?? []).filter((c) => c.id !== 'concrete'), { id: 'concrete', label: detail === NO_ITEMS_DETAIL ? 'Delivers the listings it asks for' : 'Gives a concrete answer, not "unknown"', passed: false, detail }];
      }
      changed.push(node.id);
      for (let up = byId.get(node.parentId); up; up = byId.get(up.parentId)) Object.assign(up, { status: 'pending', finding: null, verification: null, critique: null, error: null });
    }
    if (changed.length) this.emit(project, 'edit', `re-graded with the stricter answer check: ${changed.join(', ')} (now weak)`);
    return changed;
  }

  async resetResearch(id, { tree = false } = {}) {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before resetting');
    const project = await this.load(id);
    if (tree) project.nodes = [];
    for (const node of project.nodes) Object.assign(node, { status: 'pending', finding: null, verification: null, critique: null, error: null, sources: [], attempts: 0 });
    Object.assign(project, { report: null, acceptanceResult: null, phase: tree ? 'created' : 'tree-ready', error: null });
    this.emit(project, 'edit', tree ? 'tree and findings cleared: the question will be decomposed again' : 'all findings cleared: the tree will be researched again from scratch');
    return this.store.save(project);
  }

  async updateProject(id, { expected, acceptance, guidance } = {}) {
    if (typeof guidance === 'string' && expected === undefined && acceptance === undefined) return this.setGuidance(id, guidance);
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before editing');
    const project = await this.load(id);
    if (typeof guidance === 'string') project.guidance = guidance.trim().slice(0, GUIDANCE_LIMIT);
    const nextExpected = typeof expected === 'string' ? expected : project.acceptance?.expected;
    project.acceptance = { ...normalizeAcceptance(acceptance ?? project.acceptance ?? {}, nextExpected), locked: Boolean(acceptance) || Boolean(project.acceptance?.locked) };
    project.acceptanceResult = null;
    this.emit(project, 'edit', `expected result updated: ${project.acceptance.expected || 'none'}`);
    return this.store.save(project);
  }

  async setGuidance(id, guidance) {
    const project = await this.load(id);
    project.guidance = String(guidance).trim().slice(0, GUIDANCE_LIMIT);
    this.emit(project, 'edit', project.guidance ? `hints updated: ${project.guidance.slice(0, 160)}` : 'hints cleared');
    return this.store.save(project);
  }

  async editNode(id, nodeId, changes = {}) {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before editing');
    const project = await this.load(id);
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError(`node ${nodeId} not found`);
    for (const key of ['title', 'question', 'hypothesis', 'metric', 'unit']) if (typeof changes[key] === 'string') node[key] = changes[key].slice(0, 400);
    if (Array.isArray(changes.searchQueries)) node.searchQueries = strings(changes.searchQueries, 3);
    if (Array.isArray(changes.sourceUrls)) node.sourceUrls = urlList(changes.sourceUrls);
    if (typeof changes.instructions === 'string') node.instructions = changes.instructions.slice(0, 2000);
    this.resetWithAncestors(project, nodeId);
    this.emit(project, 'edit', `${nodeId}: edited, will be re-researched`, { nodeId });
    return this.store.save(project);
  }

  async addNode(id, parentId, fields = {}) {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before editing');
    const project = await this.load(id);
    const parent = parentId === ROOT_ID ? null : project.nodes.find((n) => n.id === parentId);
    if (parentId !== ROOT_ID && !parent) throw new NotFoundError(`node ${parentId} not found`);
    const base = parentId === ROOT_ID ? 'D' : `${parentId}.`;
    let i = 1;
    while (project.nodes.some((n) => n.id === `${base}${i}`)) i++;
    const question = String(fields.question ?? '').trim();
    if (!question) throw new Error('a sub-question needs text');
    const queries = strings(fields.searchQueries, 3);
    const dup = duplicateOf({ id: `${base}${i}`, parentId, title: fields.title || question, question }, project.nodes, project.question);
    if (dup) throw new Error(dup === ROOT_ID ? 'that restates the whole question; add one driver of it instead' : `that duplicates ${dup}; edit ${dup} instead`);
    const node = blankNode({ id: `${base}${i}`, parentId, title: cleanTitle(String(fields.title || question)).slice(0, 60), question, why: String(fields.why ?? '').slice(0, 300), searchQueries: queries.length ? queries : [question], sourceUrls: urlList(fields.sourceUrls), method: ['lookup', 'calculation', 'comparison', 'estimate', 'data'].includes(fields.method) ? fields.method : 'lookup' });
    project.nodes.push(node);
    if (parent) this.resetWithAncestors(project, parent.id);
    project.report = null;
    this.emit(project, 'edit', `${node.id}: added under ${parentId}`, { nodeId: node.id });
    return this.store.save(project);
  }

  async removeNode(id, nodeId) {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before editing');
    const project = await this.load(id);
    const doomed = new Set([nodeId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of project.nodes) if (doomed.has(n.parentId) && !doomed.has(n.id)) { doomed.add(n.id); grew = true; }
    }
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError(`node ${nodeId} not found`);
    if (node.parentId !== ROOT_ID) this.resetWithAncestors(project, node.parentId);
    project.nodes = project.nodes.filter((n) => !doomed.has(n.id));
    for (const n of project.nodes) n.dependsOn = n.dependsOn.filter((d) => !doomed.has(d));
    project.report = null;
    this.emit(project, 'edit', `${nodeId}: removed with ${doomed.size - 1} sub-node(s)`);
    return this.store.save(project);
  }

  async resynthesize(id) {
    if (this.running.has(id)) throw new ProjectBusyError('this project is already running');
    this.running.add(id);
    try {
      const project = await this.load(id);
      await this.synthesize(project);
      this.checkSpecs(project);
      project.phase = project.nodes.every((n) => DONE.has(n.status)) ? 'done' : project.phase;
      this.emit(project, 'phase', 'memo rewritten from the current pieces');
      return await this.store.save(project);
    } finally {
      this.running.delete(id);
    }
  }

  async rerunNode(id, nodeId, hint = '') {
    const project = await this.load(id);
    if (!project.nodes.some((n) => n.id === nodeId)) throw new NotFoundError(`node ${nodeId} not found`);
    if (this.running.has(id)) throw new ProjectBusyError('this project is already running');
    this.resetWithAncestors(project, nodeId);
    await this.store.save(project);
    this.start(id, { hints: hint ? { [nodeId]: hint } : {} });
    return project;
  }

  async expandNode(id, nodeId, hint = '') {
    if (this.running.has(id)) throw new ProjectBusyError('stop the run before editing');
    const project = await this.load(id);
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError(`node ${nodeId} not found`);
    const reply = await this.router.complete({ purpose: 'expand', tier: 'deep', messages: withGuidance(expandPrompt({ question: project.question, node, hint }), project.guidance) });
    const fresh = normalizeTree(reply.data, project.question).nodes;
    const taken = new Set(project.nodes.map((n) => n.id));
    const kept = [];
    for (const child of fresh) if (!duplicateAmong(child, [node, ...project.nodes.filter((n) => n.parentId === node.id), ...kept])) kept.push(child);
    kept.forEach((child, i) => {
      let childId = `${node.id}.${String.fromCharCode(97 + i)}`;
      while (taken.has(childId)) childId = `${childId}x`;
      taken.add(childId);
      Object.assign(child, { id: childId, parentId: node.id, dependsOn: child.dependsOn.filter((d) => taken.has(d) && d !== childId) });
      project.nodes.push(child);
    });
    this.resetWithAncestors(project, node.id);
    this.emit(project, 'tree', `${node.id}: broken into ${kept.length} sub-questions${kept.length < fresh.length ? ` (${fresh.length - kept.length} duplicate(s) dropped)` : ''}`, { nodeId: node.id });
    return this.store.save(project);
  }
}
