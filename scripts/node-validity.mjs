import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import fs from 'node:fs/promises';
import { effect } from '../src/research/nodevalidity.mjs';
import { nodeAction, SETTLED } from '../src/research/gaps.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadProject(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

function getBrokenReason(node, project) {
  if (SETTLED.has(node.status)) return null;
  const eff = effect(node);
  if (eff.broken) {
    return eff.reason;
  }
  return null;
}

function getOldAction(node, project) {
  const failed = (node.verification?.checks ?? []).filter((c) => !c.passed);
  const ids = new Set(failed.map((c) => c.id));
  const gaps = node.finding?.gaps ?? [];
  const assumptions = (node.finding?.claims ?? []).filter((c) => c.assumption).map((c) => c.text);
  const userText = [node.question, ...gaps, ...failed.map((c) => c.detail)].join(' ');
  const NEEDS_USER = /\b(owner input|your|you|user'?s?|budget|preference|which (?:one|model|option)|depends on (?:the|your)|not specified|unspecified|define|definition|ambiguous|clarify|assum(?:e|ption)s? (?:about|on) (?:the )?(?:buyer|seller|owner|company|business))\b/i;
  const WORLD_FACT = /\b(price|cost|rate|percentage|margin|revenue|profit|volume|capacity|speed|size|weight|distance|time|date|version|model|spec|feature|regulation|law|standard|certification|warranty|availability|stock|supply|demand|market|competitor|trend|growth|decline|forecast|estimate|benchmark|average|median|range|minimum|maximum)\b/i;
  const FIX_CHECKS = new Set(['answer', 'citations', 'calculation']);
  const OPEN = new Set(['pending', 'researching']);

  function isWorldFactAssumption(text) {
    return WORLD_FACT.test(text);
  }

  if (SETTLED.has(node.status)) return null;
  if (OPEN.has(node.status)) return 'research';
  if (node.status === 'failed' || node.error || [...ids].some((id) => FIX_CHECKS.has(id))) return 'fix';
  if (assumptions.length) {
    const worldFactAssumptions = assumptions.filter(isWorldFactAssumption);
    if (worldFactAssumptions.length) return 'research';
    return 'clarify';
  }
  if (NEEDS_USER.test(userText)) return 'clarify';
  const eff = effect(node);
  if (eff.broken) return 'research';
  return 'research';
}

async function main() {
  const projectPath = process.argv[2];
  if (!projectPath) {
    console.error('Usage: node scripts/node-validity.mjs <project-file>');
    process.exit(1);
  }

  const project = await loadProject(projectPath);
  console.log('\n=== Project: ' + (project.id || projectPath) + ' ===');
  console.log('Question: ' + project.question + '\n');

  const brokenNodes = [];
  for (const node of project.nodes ?? []) {
    const reason = getBrokenReason(node, project);
    if (reason) {
      brokenNodes.push({ node, reason });
      console.log('BROKEN: ' + node.id + ' ' + node.title);
      console.log('  Status: ' + node.status);
      console.log('  Reason: ' + reason);
      console.log('  Method: ' + node.method);
      console.log('  SearchQueries: ' + (node.searchQueries?.length ?? 0));
      console.log('  Sources: ' + (node.sources?.length ?? 0));
      console.log('  Finding: ' + (node.finding ? 'yes' : 'no'));
      if (node.finding) {
        console.log('  Answer: ' + (node.finding.answer?.slice(0, 100) ?? '(empty)'));
        console.log('  Claims: ' + (node.finding.claims?.length ?? 0));
        console.log('  Gaps: ' + (node.finding.gaps?.length ?? 0));
      }
      console.log('');
    }
  }

  if (brokenNodes.length === 0) {
    console.log('No broken nodes found.\n');
  }

  console.log('=== Gaps Action Comparison ===\n');
  for (const node of project.nodes ?? []) {
    const oldAction = getOldAction(node, project);
    const newAction = nodeAction(node, project);
    const oldActionStr = oldAction ?? 'none (settled)';
    const newActionStr = newAction?.action ?? 'none (settled)';
    const changed = oldActionStr !== newActionStr;
    console.log(node.id + ' ' + node.title + ' (' + node.status + ')');
    console.log('  Old action: ' + oldActionStr);
    console.log('  New action: ' + newActionStr);
    if (changed) console.log('  *** CHANGED ***');
    if (newAction) {
      console.log('  Why: ' + newAction.why);
      console.log('  Next: ' + newAction.next);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});