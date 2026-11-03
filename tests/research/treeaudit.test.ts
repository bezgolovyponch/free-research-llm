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

describe('tree repairs for loop-grown trees', () => {
  const node = (id: string, parentId: string, title: string, question: string, extra: object = {}) => ({ id, parentId, title, question, status: 'verified', dependsOn: [], ...extra });

  it('names placeholder titles from the question', async () => {
    const { repairTree, titleFromQuestion } = await import('../../src/research/treeaudit.mjs');
    expect(titleFromQuestion('Which coastal land parcels in Turkey are listed for sale under 20,000 EUR?')).toBe('Coastal land parcels in Turkey are listed for');
    const nodes = [node('D9', 'Q', 'D9', 'Which coastal land parcels in Turkey are listed for sale?'), node('D7.1.1.1', 'D7.1.1', 'A', 'Identify listed parcels in EU coastal regions'), node('D2', 'Q', 'Climate suitability', 'What is the climate?')];
    const fixes = repairTree(nodes, 'Find plots');
    expect(fixes.filter((f: { code: string }) => f.code === 'placeholder-title').map((f: { nodeId: string }) => f.nodeId)).toEqual(['D9', 'D7.1.1.1']);
    expect(nodes[2].title).toBe('Climate suitability');
  });

  it('moves drivers that repeat another driver under it, keeping their findings and every node', async () => {
    const { auditTree, mergeDuplicateDrivers } = await import('../../src/research/treeaudit.mjs');
    const q = 'Find appropriate plots to buy for a glamping business near the sea';
    const nodes = [
      node('D1', 'Q', 'Climate suitability', 'How many months per year are mild enough for glamping in Algarve?'),
      node('D6', 'Q', 'Identify affordable coastal plots', 'Which affordable coastal land parcels in Spain and Portugal are listed for sale under 20,000 EUR?'),
      node('D7', 'Q', 'Affordable coastal plot listings', 'Which affordable coastal land parcels in Spain and Portugal are listed for sale under 20,000 EUR now?', { finding: { answer: 'two plots', items: [{ url: 'https://a.example/1' }] } }),
      node('D8', 'Q', 'Affordable coastal land parcels', 'List affordable coastal land parcels in Spain and Portugal for sale under 20,000 EUR'),
    ];
    const before = auditTree(nodes, q).filter((i: { code: string }) => i.code === 'duplicate').length;
    const fixes = mergeDuplicateDrivers(nodes, q);
    expect(before).toBeGreaterThan(0);
    expect(fixes.map((f: { nodeId: string }) => f.nodeId)).toEqual(['D7', 'D8']);
    expect(nodes.map((n) => [n.id, n.parentId])).toEqual([['D1', 'Q'], ['D6', 'Q'], ['D7', 'D6'], ['D8', 'D6']]);
    expect(nodes[2].finding?.items).toHaveLength(1);
    expect(nodes[1].status).toBe('pending');
    const drivers = new Set(nodes.filter((n) => n.parentId === 'Q').map((n) => n.id));
    expect(auditTree(nodes, q).filter((i: { code: string; nodeId: string }) => i.code === 'duplicate' && drivers.has(i.nodeId))).toEqual([]);
  });
});

describe('funnel grouping', () => {
  it('moves listing-search drivers under one candidates driver when there are more than 7 drivers', async () => {
    const { CANDIDATES_TITLE, groupCandidateDrivers } = await import('../../src/research/treeaudit.mjs');
    const d = (id: string, parentId: string, question: string) => ({ id, parentId, title: question, question, status: 'verified', dependsOn: [] });
    const nodes = [
      d('D1', 'Q', 'What does land preparation cost per m2?'), d('D2', 'Q', 'How many mild months per year?'), d('D3', 'Q', 'Road distance to the beach?'), d('D4', 'Q', 'Which permits are needed?'), d('D5', 'Q', 'What nightly rates do glampings get?'), d('D5.1', 'D5', 'Average nightly rate for glamping listings near the sea'),
      d('D6', 'Q', 'Identify affordable coastal plots'), d('D7', 'D6', 'Which coastal parcels are listed for sale in Spain?'),
      d('D9', 'Q', 'Specific land parcels in coastal Turkey under 20,000 EUR'), d('D10', 'Q', 'Specific land parcels in coastal Vietnam under 20,000 EUR'),
    ];
    const fixes = groupCandidateDrivers(nodes);
    expect(fixes).toHaveLength(1);
    expect(nodes.filter((n) => n.parentId === 'Q').map((n) => n.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
    expect(nodes.filter((n) => n.parentId === 'D6').map((n) => n.id)).toEqual(['D7', 'D9', 'D10']);
    expect(nodes.find((n) => n.id === 'D5')?.title).toBe('What nightly rates do glampings get?');
    expect(nodes.find((n) => n.id === 'D6')).toMatchObject({ title: CANDIDATES_TITLE, status: 'pending' });
    expect(groupCandidateDrivers(nodes)).toEqual([]);
  });
});


describe('listing work that code does on the candidate table', () => {
  const node = (id: string, parentId: string, question: string) => ({ id, parentId, title: question, question });
  const carTree = () => [
    node('Q', 'Q', 'Find hatchback car listings within 300km from Prague up to 65000 CZK'),
    node('D1', 'Q', 'Which specific hatchback listings exist on major Austria and Czechia and Germany and Poland and Slovakia marketplaces?'),
    node('D1.1', 'D1', 'List hatchbacks <= 65,000 CZK on auto.cz, bazos.cz, inradius.cz within 300km.'),
    node('D1.2', 'D1', 'List hatchbacks <= 65,000 CZK equivalent on mobile.de, autoscout24.de within 300km.'),
    node('D1.3', 'D1', 'List hatchbacks <= 65,000 CZK equivalent on at, pl, sk sites within 300km.'),
    node('D2', 'Q', 'Do candidates meet the 300km radius and hatchback body type criteria?'),
    node('D2.1', 'D2', 'Calculate road distance from Prague to each listing location.'),
    node('D2.2', 'D2', 'Verify each listing is explicitly classified as a hatchback.'),
    node('D3', 'Q', 'Are all candidates priced at or below 65,000 CZK equivalent?'),
    node('D3.1', 'D3', 'Verify CZK listings are <= 65,000 CZK.'),
    node('D3.2', 'D3', 'Convert EUR/PLN/CHF prices to CZK and check <= 65,000 CZK.'),
    node('D4', 'Q', 'Which candidates offer the highest price-to-value ratio based on specs?'),
    node('D4.1', 'D4', 'Compare engine types and mileage against market norms for the price.'),
    node('D4.2', 'D4', 'Check empirical reliability data for specific models in the candidate pool.'),
    node('D5', 'Q', 'Are the listings live, accurate, and from reputable sellers?'),
    node('D5.1', 'D5', 'Verify that all candidate URLs are live and not 404 errors.'),
    node('D5.2', 'D5', 'Assess seller reputation based on reviews or dealer status.'),
  ];

  it('drops the per-listing pieces and keeps the knowledge and judgment ones', async () => {
    const { dropListingWork } = await import('../../src/research/treeaudit.mjs');
    const { nodes, dropped } = dropListingWork(carTree());
    expect(dropped).toEqual(['D1', 'D1.1', 'D1.2', 'D1.3', 'D2', 'D2.1', 'D2.2', 'D3', 'D3.1', 'D3.2', 'D5.1']);
    expect(nodes.map((n: { id: string }) => n.id)).toEqual(['Q', 'D4', 'D4.1', 'D4.2', 'D5', 'D5.2']);
  });

  it('tells listing work apart from knowledge a listing cannot show, and never drops the root', async () => {
    const { listingWork, dropListingWork } = await import('../../src/research/treeaudit.mjs');
    expect(listingWork('List hatchbacks <= 65,000 CZK on auto.cz within 300km.')).toBe(true);
    expect(listingWork('Which specific hatchback listings exist on German marketplaces?')).toBe(true);
    expect(listingWork('Do candidates meet the 300km radius and hatchback body type criteria?')).toBe(true);
    expect(listingWork('Which candidates offer the highest price-to-value ratio based on specs?')).toBe(false);
    expect(listingWork('Compare engine types and mileage against market norms for the price.')).toBe(false);
    expect(listingWork('Check empirical reliability data for specific models in the candidate pool.')).toBe(false);
    expect(listingWork('Assess seller reputation based on reviews or dealer status.')).toBe(false);
    expect(dropListingWork([node('Q', 'Q', 'Which specific listings exist?')]).nodes.map((n: { id: string }) => n.id)).toEqual(['Q']);
  });
});


describe('tree audit against the decision model', () => {
  it('flags pieces that name countries outside the brief and drivers that serve no check, and blocks the loop from adding them', async () => {
    const { auditModel, modelOf, BLOCKING } = await import('../../src/research/treeaudit.mjs');
    const project = { templateId: 'glamping-location', brief: { kind: { label: 'plot of land' }, regions: ['PT', 'ES', 'TR', 'VN'] } };
    const model = modelOf(project);
    const nodes = [
      { id: 'Q', parentId: null, title: 'Q', question: 'plots' },
      { id: 'D1', parentId: 'Q', title: 'Climate suitability', question: 'How many months a year are mild?' },
      { id: 'D2', parentId: 'Q', title: 'Coastal plots in Italy, Greece', question: 'Which plots in Italy and Greece are under 20,000 EUR?' },
      { id: 'D3', parentId: 'Q', title: 'Wine culture', question: 'What is the history of local wine?' },
      { id: 'D4', parentId: 'Q', title: 'Candidate listings (identification)', question: 'Which plots in Portugal are for sale?' },
      { id: 'D5', parentId: 'Q', title: 'EU land', question: 'Which EU plots are cheap?' },
    ];
    const issues = auditModel(nodes, model);
    expect(issues.map((i: { code: string; nodeId: string }) => `${i.code}:${i.nodeId}`)).toEqual(['outside-regions:D2', 'off-model:D3', 'outside-regions:D5']);
    expect(issues[0].detail).toBe('D2 names GR, IT, outside the asked regions');
    expect(issues[2].detail).toMatch(/names AT, BE, BG, HR and 21 more/);
    expect(BLOCKING.has('outside-regions') && BLOCKING.has('off-model')).toBe(true);
    expect(auditModel(nodes, modelOf({ templateId: 'taxes', brief: { regions: ['PT'] } }))).toEqual([]);
  });
});

describe('narrowing pieces to the asked countries', () => {
  const regions = ['PT', 'ES', 'TR', 'VN'];

  it('rewrites a group word to the members the user named and strikes countries outside the brief', async () => {
    const { narrowText } = await import('../../src/research/treeaudit.mjs');
    expect(narrowText('What coastal land parcels in the EU, Vietnam, and Turkey are available under 20,000 EUR?', regions)).toBe('What coastal land parcels in Portugal and Spain, Vietnam, and Turkey are available under 20,000 EUR?');
    expect(narrowText('Find parcels in EU countries (France, Germany, Spain, Italy, Portugal, Greece) priced ≤20 000 EUR', regions)).toBe('Find parcels in Portugal and Spain priced ≤20 000 EUR');
    expect(narrowText('portals for Spain, Portugal, Italy, Greece, Croatia, Turkey, and Vietnam, with URLs', regions)).toBe('portals for Spain, Portugal, Turkey, and Vietnam, with URLs');
    expect(narrowText('Plots in Spain', [])).toBe('Plots in Spain');
  });

  it('queues a rewritten piece for research and names it from its question when the title had only foreign countries', async () => {
    const { narrowRegions, repairTree } = await import('../../src/research/treeaudit.mjs');
    const nodes = [
      { id: 'Q', parentId: null, title: 'Q', question: 'q' },
      { id: 'D16', parentId: 'Q', status: 'verified', finding: { answer: 'x' }, title: 'Specific land parcels in coastal Italy, Greece, and', question: 'Find 25+ specific land parcels in Turkey and Vietnam listed for sale under 20,000 EUR' },
      { id: 'D2', parentId: 'Q', status: 'verified', finding: { answer: 'y' }, title: 'Climate', question: 'How many mild months in Portugal?' },
    ];
    const fixes = narrowRegions(nodes, regions);
    expect(fixes).toEqual([{ code: 'narrowed-regions', nodeId: 'D16', detail: 'D16 named GR, IT; rewritten to the asked countries and queued for research' }]);
    expect(nodes[1]).toMatchObject({ title: 'Find 25+ specific land parcels in Turkey', status: 'pending', finding: null });
    expect(nodes[2]).toMatchObject({ status: 'verified' });
    expect(repairTree(nodes, 'q', { regions }).filter((f: { code: string }) => f.code === 'narrowed-regions')).toEqual([]);
  });

  it('removes a leaf that researches only countries outside the brief, keeps a parent, and reads demonyms', async () => {
    const { countriesIn, narrowRegions } = await import('../../src/research/treeaudit.mjs');
    expect(countriesIn('Find Italian coastal raw land')).toEqual(['IT']);
    const nodes = [
      { id: 'Q', parentId: null, title: 'Q', question: 'q' },
      { id: 'D1', parentId: 'Q', status: 'supported', title: 'Coastal plots', question: 'Find coastal plots in Spain' },
      { id: 'D1.1', parentId: 'D1', status: 'supported', title: 'Italy – coastal raw land', question: 'Find Italian coastal raw land parcels' },
      { id: 'D1.2', parentId: 'D1', status: 'supported', title: 'Greece', question: 'Find Greek land', dependsOn: [] },
      { id: 'D2', parentId: 'Q', status: 'supported', title: 'Greek coast', question: 'Greek plots' },
      { id: 'D2.1', parentId: 'D2', status: 'supported', title: 'Spain', question: 'Spanish plots' },
    ];
    const fixes = narrowRegions(nodes, regions);
    expect(fixes.map((f: { code: string; nodeId: string }) => `${f.code}:${f.nodeId}`)).toEqual(['removed-off-scope:D1.1', 'removed-off-scope:D1.2']);
    expect(nodes.map((n) => n.id)).toEqual(['Q', 'D1', 'D2', 'D2.1']);
  });
});
