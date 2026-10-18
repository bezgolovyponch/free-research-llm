import { describeProfile, parseCsv, profileTable } from '../data/csv.mjs';
import { followUpQueries, mergeSources } from './followup.mjs';
import { AcceptanceChecker, collectDeliverables, normalizeAcceptance } from './acceptance.mjs';
import { critiquePrompt, decomposePrompt, expandPrompt, researchPrompt, rollupPrompt, synthesizePrompt } from './prompts.mjs';
import { templateById, suggestTemplate } from './templates.mjs';
import { ROOT_ID, blankNode, childrenOf, isLeaf, normalizeTree, progress, researchOrder, urlList } from './tree.mjs';
import { needsEscalation, verifyFinding } from './verify.mjs';

const CONFIDENCE = ['low', 'medium', 'high'];
const DONE = new Set(['verified', 'supported', 'weak', 'unsupported']);
const GRADE_RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0 };
const LOG_LIMIT = 300;
const MAX_ATTEMPTS = 3;

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

export class ResearchEngine {
  constructor({ router, search, store, demo = false }) {
    this.router = router;
    this.search = search;
    this.store = store;
    this.demo = demo;
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

  dataSources(project) {
    return project.data ? [project.data] : [];
  }

  async decompose(project) {
    project.phase = 'decomposing';
    this.emit(project, 'phase', 'decomposing the question into an issue tree');
    await this.store.save(project);
    const template = templateById(project.templateId);
    const reply = await this.router.complete({
      purpose: 'decompose',
      tier: 'deep',
      messages: decomposePrompt({ question: project.question, template, constraints: project.constraints, dataSummary: project.data?.text, expected: project.acceptance?.expected }),
    });
    const tree = normalizeTree(reply.data, project.question);
    if (tree.nodes.length < 2) throw new Error('the model returned an empty issue tree; try again or use a stronger model');
    const acceptance = normalizeAcceptance(reply.data?.acceptance, project.acceptance?.expected);
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

  async gatherSources(project, node) {
    const sources = [];
    if (this.search?.enabled) {
      const direct = node.sourceUrls?.length && this.search.readPages ? await this.search.readPages(node.sourceUrls) : [];
      const queries = [...node.searchQueries, node.title, node.question].filter(Boolean);
      const web = await this.search.search(queries, { maxSources: 8 - direct.length, exclude: direct.map((d) => d.url) });
      [...direct, ...web].forEach((s, i) => sources.push({ ...s, id: `S${i + 1}` }));
      if (!web.length && this.search.lastErrors.length) this.emit(project, 'warn', `${node.id}: search failed (${this.search.lastErrors.join('; ').slice(0, 200)})`, { nodeId: node.id });
    }
    return [...sources, ...this.dataSources(project)];
  }

  async searchGaps(project, node) {
    if (!this.search?.enabled || !node.finding) return;
    const queries = followUpQueries(node, node.finding, [...node.searchQueries, ...(node.followUpQueries ?? [])]);
    if (!queries.length) return;
    node.followUpQueries = [...(node.followUpQueries ?? []), ...queries];
    this.emit(project, 'node', `${node.id}: searching the gaps — ${queries.join(' | ').slice(0, 160)}`, { nodeId: node.id });
    const found = await this.search.search(queries, { maxSources: 4, exclude: node.sources.map((s) => s.url).filter(Boolean) });
    const { sources, added } = mergeSources(node.sources, found);
    node.sources = sources;
    this.emit(project, 'node', `${node.id}: ${added.length} new source(s) from gap search`, { nodeId: node.id });
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
    this.emit(project, 'node', `${node.id}: ${node.sources.length} source(s), analysing`, { nodeId: node.id });
    let failures = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const tier = attempt === 1 ? 'fast' : 'deep';
      if (attempt > 1) await this.searchGaps(project, node);
      const reply = await this.router.complete({
        purpose: 'research',
        tier,
        messages: researchPrompt({ question: project.question, node, sources: node.sources, upstream: this.upstreamFor(project, node), previousFailures: failures, hint, expected: project.acceptance?.expected }),
      });
      const finding = normalizeFinding(reply.data);
      const critique = await this.critique(node, finding, node.sources, reply.provider);
      const verification = verifyFinding({ finding, sources: node.sources, critique, node });
      Object.assign(node, { finding, critique, verification, attempts: attempt, model: `${reply.provider}/${reply.model}`, status: verification.grade });
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
    const reply = await this.router.complete({ purpose: 'rollup', tier: 'fast', messages: rollupPrompt({ question: project.question, node, children }) });
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
      messages: synthesizePrompt({ question: project.question, decision: project.decision, successCriteria: project.successCriteria, template, constraints: project.constraints, nodes: project.nodes, expected: project.acceptance?.expected }),
    });
    const r = reply.data ?? {};
    const counts = progress(project.nodes);
    project.report = {
      verdict: String(r.verdict ?? '').slice(0, 300),
      confidence: CONFIDENCE.includes(r.confidence) ? r.confidence : 'low',
      summary: String(r.summary ?? '').slice(0, 2500),
      keyNumbers: (Array.isArray(r.keyNumbers) ? r.keyNumbers : []).slice(0, 12),
      scenarios: (Array.isArray(r.scenarios) ? r.scenarios : []).slice(0, 4),
      sensitivity: (Array.isArray(r.sensitivity) ? r.sensitivity : []).slice(0, 8),
      risks: strings(r.risks, 10),
      openQuestions: strings(r.openQuestions, 10),
      nextSteps: (Array.isArray(r.nextSteps) ? r.nextSteps : []).slice(0, 10),
      evidenceQuality: { ...counts, weak: project.nodes.filter((n) => ['weak', 'unsupported', 'failed'].includes(n.status)).map((n) => n.id) },
      model: `${reply.provider}/${reply.model}`,
      generatedAt: new Date().toISOString(),
    };
    await this.checkAcceptance(project);
    this.emit(project, 'report', `decision memo ready: ${project.report.verdict}`);
  }

  async checkAcceptance(project) {
    const deliverables = collectDeliverables(project.nodes);
    project.report.deliverables = deliverables;
    const checker = new AcceptanceChecker({ readPage: this.search?.readPage ? (url) => this.search.readPage(url) : null });
    project.acceptanceResult = await checker.evaluate(project.acceptance, deliverables);
    if (project.acceptanceResult) this.emit(project, 'acceptance', `expected result: ${Math.round(project.acceptanceResult.score * 100)}% — ${project.acceptanceResult.checks.map((c) => `${c.label} ${Math.round(c.value * 100)}%`).join(' · ')}`);
  }

  async run(id, { hints = {} } = {}) {
    if (this.running.has(id)) throw new ProjectBusyError('this project is already running');
    this.running.add(id);
    this.cancelled.delete(id);
    let project;
    try {
      project = await this.load(id);
      if (!project.nodes.length) await this.decompose(project);
      project.phase = 'researching';
      project.error = null;
      for (const node of project.nodes) if (node.status === 'failed' || node.status === 'researching') node.status = 'pending';
      this.emit(project, 'phase', 'researching sub-questions in dependency order');
      await this.store.save(project);
      const byId = new Map(project.nodes.map((n) => [n.id, n]));
      for (const nodeId of researchOrder(project.nodes)) {
        if (this.cancelled.has(id)) {
          project.phase = 'cancelled';
          this.running.delete(id);
          this.emit(project, 'phase', 'stopped by user');
          return await this.store.save(project);
        }
        const node = byId.get(nodeId);
        if (DONE.has(node.status)) continue;
        try {
          if (isLeaf(project.nodes, node)) await this.researchLeaf(project, node, hints[node.id]);
          else await this.rollup(project, node);
        } catch (error) {
          node.status = 'failed';
          node.error = error.message;
          this.emit(project, 'error', `${node.id}: ${error.message}`, { nodeId: node.id });
          if (/no model provider|cooling down/.test(error.message)) throw error;
        }
        await this.store.save(project);
      }
      await this.synthesize(project);
      project.phase = 'done';
      this.running.delete(id);
      this.emit(project, 'phase', 'done');
      return await this.store.save(project);
    } catch (error) {
      if (project) {
        project.phase = 'error';
        project.error = error.message;
        this.emit(project, 'error', error.message);
        await this.store.save(project);
      }
      throw error;
    } finally {
      this.running.delete(id);
    }
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
    project.report = null;
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
    const node = blankNode({ id: `${base}${i}`, parentId, title: question.slice(0, 60), question, searchQueries: [question] });
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
    const reply = await this.router.complete({ purpose: 'expand', tier: 'deep', messages: expandPrompt({ question: project.question, node, hint }) });
    const fresh = normalizeTree(reply.data, project.question).nodes;
    const taken = new Set(project.nodes.map((n) => n.id));
    fresh.forEach((child, i) => {
      let childId = `${node.id}.${String.fromCharCode(97 + i)}`;
      while (taken.has(childId)) childId = `${childId}x`;
      taken.add(childId);
      Object.assign(child, { id: childId, parentId: node.id, dependsOn: child.dependsOn.filter((d) => taken.has(d) && d !== childId) });
      project.nodes.push(child);
    });
    this.resetWithAncestors(project, node.id);
    this.emit(project, 'tree', `${node.id}: broken into ${fresh.length} sub-questions`, { nodeId: node.id });
    return this.store.save(project);
  }
}
