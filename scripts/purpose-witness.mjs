import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeychainSecrets } from '../src/secrets.mjs';
import { App } from '../src/app.mjs';
import { verdict } from '../src/research/verdict.mjs';

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
  const copied = path.join(outDir, 'data', projectId + '.json');
  const project = JSON.parse(await fs.readFile(await fs.access(copied).then(() => copied, () => projectPath), 'utf8'));

  await fs.mkdir(path.join(outDir, 'data'), { recursive: true });
  await fs.writeFile(copied, JSON.stringify(project, null, 1));

  const secrets = new KeychainSecrets();
  await secrets.fillMissing(process.env);

  const app = new App({ dataDir: path.join(outDir, 'data') });
  await app.refreshProviders();

  const engine = app.engine;

  await engine.ensurePurposeTree(project);
  await engine.checkAcceptance(project);
  await engine.store.save(project, { reason: 'purpose witness' });
  const acceptanceResult = project.acceptanceResult;
  const verdictResult = acceptanceResult.verdict ?? verdict(acceptanceResult.items, project.acceptance, project.decisionModel?.checklist ?? null, project.decisionModel?.kind ?? null);

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
  if (project.purposeTree?.goals) {
    for (const goal of project.purposeTree.goals) {
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