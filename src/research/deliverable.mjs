import { itemCountFromWords } from './acceptance.mjs';

const ASKS_FOR_ITEMS = /\b(?:listed (?:for sale|on)|for sale|on sale|direct (?:urls?|links?)|(?:plot|land|property|parcel|real estate) listings?|specific (?:land |coastal |rural )?(?:parcels?|plots?|properties|listings?|offers?))\b/i;

export const NO_ITEMS_DETAIL = 'asked for specific listings but returned none';

export function askedUnit(project) {
  if (!process.env.FRL_ANSWER_UNIT) return null;
  const model = project?.decisionModel;
  if (model?.answerUnit && model.answerUnitQuote) return model.answerUnit;
  const own = process.env.FRL_UNIT_EVERY_QUESTION ? project?.answerUnit : null;
  return own?.answerUnit && own.answerUnitQuote ? own.answerUnit : null;
}

export function answersWithNumber(project) {
  return (Boolean(process.env.FRL_ANSWER_UNIT) && project?.decisionModel?.answerUnit === 'number' && Boolean(project.decisionModel.answerUnitQuote)) || (Boolean(process.env.FRL_UNIT_EVERY_QUESTION) && askedUnit(project) === 'number');
}

export function listCount(project) {
  return answersWithNumber(project) ? null : project?.acceptance?.itemCount ?? null;
}

export function contractClass(project) {
  if (!project) return 'analysis';
  if (answersWithNumber(project)) return 'analysis';
  const asked = itemCountFromWords(project.acceptance?.expected, project.question);
  if (typeof asked === 'number') return 'list';
  const kind = project.decisionModel?.kind ?? project.brief?.kind ?? null;
  if (kind?.label) return 'list';
  return 'analysis';
}

export function asksForItems(node) {
  if (!node) return false;
  if (typeof node.deliverable === 'boolean') return node.deliverable;
  return ASKS_FOR_ITEMS.test(`${node.title ?? ''} ${node.question ?? ''}`);
}

export function deliversItems(node) {
  return (node?.finding?.items ?? []).some((item) => item && item.url);
}

export function missingItems(node) {
  return asksForItems(node) && !deliversItems(node);
}
