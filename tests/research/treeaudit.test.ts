import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { auditTree, cleanTitle, duplicateAmong, duplicateOf, repairTree, similarity } from '../../src/research/treeaudit.mjs';

const n = (id: string, parentId: string, title: string, question: string, dependsOn: string[] = []) => ({ id, parentId, title, question, dependsOn });
const Q = 'Find appropriate plots to buy for a glamping business on the coast, max 20000 EUR, mild climate 10 months a year, near the sea and e-bike routes';

function glampingTree() {
  return [
    n('D1', 'Q', 'Land cost feasibility', 'What average land price per m² in Spain, Portugal, Turkey coastal zones 2026?'),
    n('D1.1', 'D1', 'Affordable parcels count', 'How many parcels ≤20,000 EUR exist in each country coastal region?', ['D1']),
    n('D2', 'Q', 'Climate suitability', 'Average summer temperatures and frost days in target coastal areas?'),
    n('D2.1', 'D2', 'Season length', 'How many months per year have suitable weather for glamping?', ['D2']),
    n('D2.2', 'D2', 'Frost risk', 'How many frost days per winter in each region?'),
    n('D6', 'Q', 'Identify affordable coastal plots for glamping', 'What coastal land plots near the sea are available to buy for glamping under 20000 EUR with mild climate and e-bike routes?'),
    n('D7', 'Q', 'D7: Affordable coastal plot listings for glamping', 'Which coastal land plots for glamping under 20000 EUR are listed?'),
    n('D8', 'Q', 'D8: Identify affordable coastal land parcels for glamping', 'Which coastal land parcels for glamping under 20000 EUR are listed?'),
  ];
}

describe('tree audit (structural gate for the decomposition)', () => {
  it('finds the defects of the real glamping tree: own-branch dependencies, single child, a driver that restates the question, duplicate drivers, ids in titles', () => {
    const issues = auditTree(glampingTree(), Q);
    const codes = (code: string) => issues.filter((i: { code: string }) => i.code === code).map((i: { nodeId: string }) => i.nodeId);
    expect(codes('dependency-on-own-branch')).toEqual(['D1.1', 'D2.1']);
    expect(codes('single-child')).toEqual(['D1']);
    expect(codes('restates-question')).toContain('D6');
    expect(codes('duplicate')).toContain('D8');
    expect(codes('id-in-title')).toEqual(['D7', 'D8']);
  });

  it('repairs what code can fix by itself: ids in titles and dependencies on the own branch', () => {
    const nodes = glampingTree();
    const fixes = repairTree(nodes);
    expect(fixes.map((f: { code: string; nodeId: string }) => `${f.nodeId}:${f.code}`)).toEqual(expect.arrayContaining(['D1.1:dependency-on-own-branch', 'D2.1:dependency-on-own-branch', 'D7:id-in-title', 'D8:id-in-title']));
    expect(nodes.find((x) => x.id === 'D7')!.title).toBe('Affordable coastal plot listings for glamping');
    expect(nodes.find((x) => x.id === 'D1.1')!.dependsOn).toEqual([]);
    expect(auditTree(nodes, Q).some((i: { code: string }) => i.code === 'dependency-on-own-branch' || i.code === 'id-in-title')).toBe(false);
  });

  it('rejects a new piece that duplicates a sibling or restates the question, and keeps a genuinely new one', () => {
    const nodes = glampingTree();
    expect(duplicateOf({ id: 'D9', parentId: 'Q', title: 'Affordable coastal plots', question: 'Which affordable coastal plots for glamping under 20000 EUR are listed?' }, nodes, Q)).not.toBeNull();
    expect(duplicateOf({ id: 'D9', parentId: 'Q', title: 'Water and power hookup', question: 'What does connecting water and electricity to a rural plot cost?' }, nodes, Q)).toBeNull();
    expect(duplicateAmong({ id: 'x', title: 'Frost risk', question: 'Frost days per winter in each region' }, nodes)).toBe('D2.2');
    expect(cleanTitle('D1.2 · Land price')).toBe('Land price');
    expect(similarity('', 'x')).toBe(0);
  });

  it('property: for any random tree, repair leaves no own-branch dependency, no id in a title, and never invents or loses a node', () => {
    const tree = fc.integer({ min: 1, max: 5 }).chain((drivers) => fc.array(fc.integer({ min: 0, max: 3 }), { minLength: drivers, maxLength: drivers }).chain((kids) => {
      const ids: Array<{ id: string; parentId: string }> = [];
      kids.forEach((k, i) => {
        ids.push({ id: `D${i + 1}`, parentId: 'Q' });
        for (let j = 1; j <= k; j++) ids.push({ id: `D${i + 1}.${j}`, parentId: `D${i + 1}` });
      });
      return fc.tuple(fc.constant(ids), fc.array(fc.tuple(fc.nat(ids.length - 1), fc.nat(ids.length - 1)), { maxLength: 12 }), fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }));
    }));
    fc.assert(fc.property(tree, ([ids, deps, prefixed]) => {
      const nodes = ids.map((x, i) => ({ ...x, title: `${prefixed[i] ? `${x.id}: ` : ''}piece ${x.id}`, question: `question about ${x.id}`, dependsOn: [] as string[] }));
      for (const [a, b] of deps) nodes[a].dependsOn.push(nodes[b].id);
      repairTree(nodes);
      const left = auditTree(nodes, '');
      expect(left.filter((i: { code: string }) => i.code === 'dependency-on-own-branch' || i.code === 'id-in-title')).toEqual([]);
      expect(nodes.map((x) => x.id)).toEqual(ids.map((x) => x.id));
      for (const x of nodes) for (const d of x.dependsOn) expect(ids.some((y) => y.id === d)).toBe(true);
    }), { numRuns: 300 });
  });
});
