import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeychainSecrets } from '../src/secrets.mjs';
import { App } from '../src/app.mjs';
import { ResearchEngine } from '../src/research/engine.mjs';
import { AcceptanceChecker, collectDeliverables, entityDeliverables, purposeChecks, isExcludedSurfaceUrl } from '../src/research/acceptance.mjs';
import { buildBrief } from '../src/research/brief.mjs';
import { candidateDeliverables } from '../src/research/candidates.mjs';
import { verdict } from '../src/research/verdict.mjs';
import { ExchangeRates } from '../src/research/rates.mjs';
import { SearchService } from '../src/search/search.mjs';
import { SiteAssessor } from '../src/research/site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function insideRepo(dir) {
  const relative = path.relative(ROOT, path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = args[0];
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 ? args[outIndex + 1] : null;

  if (!projectId || !outDir) {
    console.error('usage: node scripts/purpose-witness.mjs <projectId> --out <dir outside the repo>');
    process.exit(1);
  }

  if (insideRepo(outDir)) {
    console.error('--out must be a folder outside the repository (' + ROOT + '); nothing was written');
    process.exit(1);
  }

  const projectPath = path.join(ROOT, 'data', 'projects', projectId + '.json');
  const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));

  await fs.mkdir(path.join(outDir, 'data', 'projects'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'data', 'projects', projectId + '.json'), JSON.stringify(project, null, 1));

  const secrets = new KeychainSecrets();
  await secrets.fillMissing(process.env);

  const app = new App({ dataDir: path.join(outDir, 'data') });
  await app.refreshProviders();

  const engine = app.engine;

  const brief = buildBrief({ question: project.question, acceptance: project.acceptance ?? {}, constraints: project.constraints ?? {} });
  if (!brief.regions?.length && project.area?.countries?.length) brief.regions = project.area.countries;

  const CallBudget = (await import('../src/research/semantic.mjs')).CallBudget;
  const { Embedder } = await import('../src/llm/embedder.mjs');
  const ctx = {
    router: app.router,
    search: app.search,
    embedder: app.engine.embedder ?? new Embedder({ env: process.env, dir: path.join(outDir, 'embeddings') }),
    budget: new CallBudget(),
    log: (msg) => console.log('  ' + msg),
  };

  await engine.studyDomain(project);

  const { buildPurposeTree } = await import('../src/research/purpose.mjs');
  const purposeResult = await buildPurposeTree(ctx, {
    question: project.question,
    guidance: project.guidance ?? '',
    notes: project.scoping?.notes ?? [],
    answers: [],
  });

  project.purposeTree = purposeResult.tree;

  const DecisionModeler = (await import('../src/research/decision.mjs')).DecisionModeler;
  const modeler = new DecisionModeler({ router: app.router, cases: app.cases });
  await modeler.build(project, { force: true });

  const convert = engine.rates ? await engine.rates.converter() : undefined;
  const readPage = engine.cachedPageReader(null);

  const terms = [...new Set([...(project.domain?.terms ?? []), ...(project.decisionModel?.kind?.terms ?? []), ...(brief.kind?.terms ?? [])])];
  const notTerms = [...new Set([...(project.domain?.not ?? []), ...(project.decisionModel?.kind?.not ?? []), ...(brief.kind?.not ?? [])])];
  const kindLabel = project.decisionModel?.kind?.label ?? brief.kind?.label ?? '';
  const nodesForEntities = [...(project.nodes ?? []), { id: 'hubs', sources: project.hubSources ?? [] }];

  const fromTable = candidateDeliverables(project.candidates);
  const listed = new Set(fromTable.map((d) => d.url));
  const deliverables = (brief.located === false
    ? await entityDeliverables(nodesForEntities, { terms, not: notTerms, kindLabel, regions: brief.regions ?? [], readPage })
    : (project.candidates ? fromTable : [...fromTable, ...collectDeliverables(project.nodes).filter((d) => !listed.has(d.url))])).filter((d) => !isExcludedSurfaceUrl(d.url));

  const acceptanceResult = await new AcceptanceChecker({ readPage, convert }).evaluate(
    project.acceptance,
    deliverables,
    { located: brief.located !== false, kind: brief.kind ?? null, purpose: purposeChecks(project), checklist: project.decisionModel?.checklist ?? null }
  );

  const verdictResult = verdict(acceptanceResult.items, project.acceptance, project.decisionModel?.checklist ?? null, project.decisionModel?.kind ?? null);

  const modelCallsByStage = {};
  if (app.router.ledger) {
    for (const call of app.router.ledger) {
      const purpose = call.purpose || 'unknown';
      modelCallsByStage[purpose] = (modelCallsByStage[purpose] || 0) + 1;
    }
  }

  const hardChecksMap = {};
  for (const pc of verdictResult.perCheck) {
    hardChecksMap[pc.id] = { pass: pc.yes, fail: pc.no, unknown: pc.unknown };
  }

  const purposeTreeGoals = [];
  if (purposeResult.tree?.goals) {
    for (const goal of purposeResult.tree.goals) {
      if (goal.state === 'kept') {
        purposeTreeGoals.push({
          id: goal.id,
          goal: goal.goal,
          refine: goal.refine,
          hard: goal.goalHard ?? false,
          traceAnchor: goal.trace?.id ?? goal.anchor ?? null,
        });
      }
    }
  }

  const checklistItems = [];
  if (project.decisionModel?.checklist) {
    for (const cluster of project.decisionModel.checklist) {
      for (const item of cluster.items) {
        checklistItems.push({
          question: item.question,
          checker: item.checker,
          scope: item.scope,
          hard: item.hard,
          numeric: item.numeric,
        });
      }
    }
  }

  const acceptanceCounts = {
    confirmed: verdictResult.tiers.confirmed,
    toConfirm: verdictResult.tiers.toConfirm,
    rejected: verdictResult.tiers.rejected,
    delivered: acceptanceResult.items.length,
  };

  const hardCheckPassCounts = {};
  for (const [id, counts] of Object.entries(hardChecksMap)) {
    hardCheckPassCounts[id] = { pass: counts.pass, fail: counts.fail, unknown: counts.unknown };
  }

  const rows = [];
  for (const item of verdictResult.items.slice(0, 10)) {
    const failingOrUnknown = [];
    for (const check of item.checks ?? []) {
      if (check.hard && (check.answer === 'no' || check.answer === 'unknown' || check.answer === '')) {
        failingOrUnknown.push({
          checkId: check.id,
          answer: check.answer,
          quote: check.quote,
        });
      }
    }
    rows.push({
      title: item.title,
      url: item.url,
      tier: item.tier,
      failingOrUnknownChecks: failingOrUnknown,
    });
  }

  const output = {
    purposeTreeGoals,
    checklistItems,
    acceptanceCounts,
    hardCheckPassCounts,
    modelCallsByStage,
    rows,
  };

  console.log(JSON.stringify(output, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});