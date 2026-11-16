import { describe, it, expect } from "vitest";
import { itemTier, itemEvidence, verdict, verdictInvariants, hardIdsOf, qualifies, acceptanceSummaryOf } from "../../src/research/verdict.mjs";
import { ChecklistJudge, LOW_PRICE_REASON, hardenKind, kindCluster, migrateChecks } from "../../src/research/checklist.mjs";
import { lowPriceStats } from "../../src/research/candidates.mjs";
import { fakeRouter } from "../helpers/fakes";
import fixture from "../fixtures/verdict-0c750f.json";

describe("verdict", () => {
  const hardIds = ["check1", "check2", "check3"];
  
  const baseItem = (overrides = {}) => ({
    live: true,
    listing: true,
    inRange: true,
    purpose: [{ passed: true }],
    checks: [],
    ...overrides
  });

  it("confirmed: all hard checks yes, qualifies true", () => {
    const item = baseItem({
      checks: [
        { id: "check1", answer: "yes", hard: true },
        { id: "check2", answer: "yes", hard: true },
        { id: "check3", answer: "yes", hard: true },
      ],
      qualifies: true,
    });
    expect(itemTier(item, hardIds)).toBe("confirmed");
  });

  it("rejected: any hard check no", () => {
    const item = baseItem({
      checks: [
        { id: "check1", answer: "yes", hard: true },
        { id: "check2", answer: "no", hard: true },
        { id: "check3", answer: "yes", hard: true },
      ],
      qualifies: true,
    });
    expect(itemTier(item, hardIds)).toBe("rejected");
  });

  it("rejected: qualifies false", () => {
    const item = baseItem({
      checks: [
        { id: "check1", answer: "yes", hard: true },
        { id: "check2", answer: "yes", hard: true },
        { id: "check3", answer: "yes", hard: true },
      ],
      live: false,
    });
    expect(itemTier(item, hardIds)).toBe("rejected");
  });

  it("to-confirm: no hard no, at least one unknown", () => {
    const item = baseItem({
      checks: [
        { id: "check1", answer: "yes", hard: true },
        { id: "check2", answer: "unknown", hard: true },
        { id: "check3", answer: "yes", hard: true },
      ],
      qualifies: true,
    });
    expect(itemTier(item, hardIds)).toBe("to-confirm");
  });

  it("not-judged: checklist has hard items but item has no checks", () => {
    const item = baseItem({
      checks: [],
      qualifies: true,
    });
    expect(itemTier(item, hardIds)).toBe("not-judged");
  });

  it("no hard items in checklist: confirmed iff qualifies", () => {
    const item = baseItem({ qualifies: true, checks: [] });
    expect(itemTier(item, [])).toBe("confirmed");
    
    const item2 = baseItem({ live: false, checks: [] });
    expect(itemTier(item2, [])).toBe("rejected");
  });

  it("veto: 5 yes + 1 hard no = rejected", () => {
    const item = baseItem({
      checks: [
        { id: "check1", answer: "yes", hard: true },
        { id: "check2", answer: "yes", hard: true },
        { id: "check3", answer: "yes", hard: true },
        { id: "check4", answer: "yes", hard: true },
        { id: "check5", answer: "yes", hard: true },
        { id: "check6", answer: "no", hard: true },
      ],
      qualifies: true,
    });
    expect(itemTier(item, ["check1", "check2", "check3", "check4", "check5", "check6"])).toBe("rejected");
  });

  it("itemEvidence: belief = yes share, plausibility = 1 - no share", () => {
    const item = baseItem({
      checks: [
        { id: "check1", answer: "yes", hard: true },
        { id: "check2", answer: "unknown", hard: true },
        { id: "check3", answer: "no", hard: true },
      ],
    });
    const ev = itemEvidence(item, hardIds);
    expect(ev.belief).toBeCloseTo(1/3);
    expect(ev.plausibility).toBeCloseTo(2/3);
    expect(ev.open).toEqual(["check2"]);
  });

  it("itemEvidence: no checks = open all hardIds", () => {
    const item = baseItem({ checks: [] });
    const ev = itemEvidence(item, hardIds);
    expect(ev.belief).toBe(0);
    expect(ev.plausibility).toBe(1);
    expect(ev.open).toEqual(hardIds);
  });

  it("verdict: tier counts and summary", () => {
    const items = [
      baseItem({ url: "1", checks: [{ id: "c|q1", answer: "yes", hard: true }, { id: "c|q2", answer: "yes", hard: true }], qualifies: true }),
      baseItem({ url: "2", checks: [{ id: "c|q1", answer: "yes", hard: true }, { id: "c|q2", answer: "unknown", hard: true }], qualifies: true }),
      baseItem({ url: "3", checks: [{ id: "c|q1", answer: "no", hard: true }], qualifies: true }),
      baseItem({ url: "4", checks: [], qualifies: true }),
    ];
    const spec = { itemCount: 4 };
    const checklist = [{ clause: "c", items: [{ id: "check1", hard: true, question: "q1" }, { id: "check2", hard: true, question: "q2" }] }];

    const result = verdict(items, spec, checklist);

    expect(result.tiers.confirmed).toBe(1);
    expect(result.tiers.toConfirm).toBe(1);
    expect(result.tiers.rejected).toBe(1);
    expect(result.tiers.notJudged).toBe(1);
    expect(result.validCount).toBe(1);
    expect(result.asked).toBe(4);
    expect(result.summary).toContain("1 of 4 confirmed");
    expect(result.summary).toContain("1 to confirm");
    expect(result.summary).toContain("1 rejected");
    expect(result.summary).toContain("1 not read");
  });

  it("verdict: vague detection threshold", () => {
    const items = Array.from({ length: 10 }, (_, i) => baseItem({
      url: String(i),
      checks: [
        { id: "c|q1", answer: i < 5 ? "yes" : "unknown", hard: true },
        { id: "c|q2", answer: "yes", hard: true },
      ],
      qualifies: true,
    }));
    const spec = { itemCount: 10 };
    const checklist = [{ clause: "c", items: [{ id: "check1", hard: true, question: "q1" }, { id: "check2", hard: true, question: "q2" }] }];

    const result = verdict(items, spec, checklist);

    expect(result.vague).toContain("c|q1");
    expect(result.vague).not.toContain("c|q2");
  });

  it("verdict: items sorted by tier, then soft yes, then belief", () => {
    const items = [
      baseItem({ url: "a", checks: [{ id: "check1", answer: "yes", hard: true }, { id: "check2", answer: "yes", hard: true }, { id: "soft1", answer: "yes", hard: false }], qualifies: true }),
      baseItem({ url: "b", checks: [{ id: "check1", answer: "yes", hard: true }, { id: "check2", answer: "yes", hard: true }], qualifies: true }),
      baseItem({ url: "c", checks: [{ id: "check1", answer: "yes", hard: true }, { id: "check2", answer: "unknown", hard: true }], qualifies: true }),
    ];
    const spec = { itemCount: 3 };
    const checklist = [{ clause: "c", items: [{ id: "check1", hard: true, question: "q1" }, { id: "check2", hard: true, question: "q2" }] }];
    
    const result = verdict(items, spec, checklist);
    
    expect(result.items[0].url).toBe("a");
    expect(result.items[1].url).toBe("b");
    expect(result.items[2].url).toBe("c");
  });

  it("verdictInvariants: flags mismatched validCount", () => {
    const project = {
      acceptance: { itemCount: 5 },
      checklist: [{ clause: "c", items: [{ id: "check1", hard: true, question: "q1" }] }],
      acceptanceResult: {
        items: [
          baseItem({ url: "1", checks: [{ id: "check1", answer: "yes", hard: true }], qualifies: true }),
        ],
        validCount: 5,
      },
    };
    const reasons = verdictInvariants(project);
    expect(reasons).toContainEqual(expect.stringContaining("validCount mismatch"));
  });

  it("verdictInvariants: flags confirmed item missing yes on hard check", () => {
    const project = {
      acceptance: { itemCount: 5 },
      checklist: [{ clause: "c", items: [{ id: "check1", hard: true, question: "q1" }] }],
      acceptanceResult: {
        items: [
          baseItem({ url: "1", checks: [{ id: "c|q1", answer: "yes", hard: true }], qualifies: true }),
        ],
        validCount: 5,
      },
    };
    const reasons = verdictInvariants(project);
    expect(reasons).toContainEqual(expect.stringContaining("validCount mismatch"));
  });

  it("verdictInvariants: flags itemCount set but no checklist", () => {
    const project = {
      acceptance: { itemCount: 5 },
      checklist: [],
      acceptanceResult: { items: [], validCount: 0 },
    };
    const reasons = verdictInvariants(project);
    expect(reasons).toContainEqual(expect.stringContaining("no checklist items"));
  });

  it("replay fixture: verdict-0c750f.json", () => {
    const { acceptance, checklist, acceptanceResult } = fixture;
    const result = verdict(acceptanceResult.items, acceptance, checklist);

    expect(result.validCount).toBe(1);
    expect(result.vague).toContain("accurate and verified listing|Does this listing provide accurate and verified car listings?");
    expect(result.summary).toContain("1 of 20 confirmed");
  });

  it("hardIdsOf: kind id built from kind label via kindCluster", () => {
    const checklist = [{ clause: "c", items: [{ id: "check1", hard: true, question: "q1" }] }];

    const kind1 = { label: "used car", terms: ["hatchback"], not: ["parts"] };
    const ids1 = hardIdsOf(checklist, kind1);
    expect(ids1).toContain("kind|Is this page one used car offered as asked (not a part, accessory, wanted ad or list and not parts)?");

    const kind2 = { label: "wholesale clothing provider", terms: ["wholesale clothing"], not: ["retail"] };
    const ids2 = hardIdsOf(checklist, kind2);
    expect(ids2).toContain("kind|Is this page one wholesale clothing provider offered as asked (not a part, accessory, wanted ad or list and not retail)?");

    const idsNoKind = hardIdsOf(checklist, null);
    expect(idsNoKind).not.toContainEqual(expect.stringMatching(/^kind\|/));

    const idsNoChecklist = hardIdsOf(null, kind1);
    expect(idsNoChecklist).not.toContainEqual(expect.stringMatching(/^kind\|/));
  });

  it("hardIdsOf: a category kind adds the one kind question the judge asks, naming its kinds", () => {
    const checklist = [{ clause: "c", items: [{ hard: true, question: "q1" }] }];
    const category = { label: "home improvement contractor", terms: ["home improvement contractor"], members: [{ label: "roofer", terms: ["roofing"] }, { label: "plumber", terms: ["plumbing"] }] };
    const expectedId = "kind|" + kindCluster(category).items[0].question;
    const ids = hardIdsOf(checklist, category);
    expect(ids.filter((id) => id.startsWith("kind|"))).toEqual([expectedId]);
    expect(expectedId).toContain("of one of these kinds: roofer, plumber");
  });

  it("all hard checks yes never rescue a dead link or a value out of range", () => {
    const yes = [{ id: "check1", answer: "yes", hard: true }, { id: "check2", answer: "yes", hard: true }, { id: "check3", answer: "yes", hard: true }];
    expect(qualifies(baseItem({ live: false, checks: yes }), {})).toBe(false);
    expect(itemTier(baseItem({ live: false, checks: yes }), hardIds)).toBe("rejected");
    expect(itemTier(baseItem({ inRange: false, checks: yes }), hardIds, { valueRange: [0, 10] })).toBe("rejected");
    expect(itemTier(baseItem({ purpose: [{ passed: false }], checks: yes }), hardIds)).toBe("rejected");
  });

  it("keeps an entity's evidence link and stores belief and plausibility apart from it", () => {
    const entity = baseItem({ url: "https://seller.example/", listing: false, evidence: "https://directory.example/seller", checks: [{ id: "check1", answer: "yes", hard: true }, { id: "check2", answer: "unknown", hard: true }] });
    const [item] = verdict([entity], { itemCount: 1 }, [{ clause: "c", items: [] }]).items;
    expect(item.evidence).toBe("https://directory.example/seller");
    expect(item.support).toEqual({ belief: 1, plausibility: 1, open: [] });
    const judged = verdict([entity], { itemCount: 1 }, null).items[0];
    expect(judged.evidence).toBe("https://directory.example/seller");
    expect(qualifies({ ...entity, evidence: undefined }, {})).toBe(false);
  });

  it("a project without an acceptance spec still gets a verdict", () => {
    expect(verdict([baseItem()], undefined, null).summary).toBe("1 of 1 confirmed");
  });

  it("one summary sentence for every caller: the stored verdict, else computed from the items", () => {
    const stored = { acceptanceResult: { verdict: { summary: "2 of 5 confirmed" }, items: [] }, acceptance: { itemCount: 5 } };
    expect(acceptanceSummaryOf(stored)).toBe("2 of 5 confirmed");
    const unread = { acceptanceResult: { totalAsked: 20, items: [baseItem({ url: "a", checks: [] })] }, acceptance: { itemCount: 20 }, checklist: [{ clause: "c", items: [{ hard: true, question: "q1" }] }] };
    expect(acceptanceSummaryOf(unread)).toBe("0 of 20 confirmed · 1 not read");
    expect(acceptanceSummaryOf({ acceptance: { itemCount: 3 } })).toBe("0 of 3 confirmed");
  });
});

describe("stored answers of the 0c750f fixture under the quote rule and the price rule", () => {
  const kind = { label: "car listing", terms: ["car"], not: ["wanted", "parts", "accessories", "retail"] };
  const tyres = "https://auto.bazos.cz/inzerat/226132468/zimni-pneu-na-plechacich-kia-ceed.php";
  const copy = () => JSON.parse(JSON.stringify(fixture));

  it("had the tyres on rims with a kind yes at a twelfth of the median, rejected only by another check", () => {
    const { acceptance, checklist, acceptanceResult } = copy();
    const item = verdict(acceptanceResult.items, acceptance, checklist, kind).items.find((i: { url: string }) => i.url === tyres);
    expect(item.checks.find((c: { clause: string }) => c.clause === "kind").answer).toBe("yes");
    expect(item.value).toBe(2000);
    expect(item.tier).toBe("rejected");
  });

  it("the item whose answer had an empty quote is to-confirm after the migration, and one item is still confirmed", () => {
    const project = copy();
    expect(migrateChecks(project)).toBe(1);
    const result = verdict(project.acceptanceResult.items, project.acceptance, project.checklist);
    expect(result.items.find((i: { url: string }) => i.url === tyres).tier).toBe("to-confirm");
    expect(result.validCount).toBe(1);
  });

  const kindId = "kind|" + kindCluster(kind).items[0].question;
  const hardened = async (project: ReturnType<typeof copy>, url: string, router: ReturnType<typeof fakeRouter>) => {
    const prices = lowPriceStats(project.acceptanceResult.items);
    const item = project.acceptanceResult.items.find((i: { url: string }) => i.url === url);
    const pageText = item.checks.find((c: { clause: string }) => c.clause === "kind").quote || "Škoda Fabia 1.2 na prodej. Najeto 150 000 km a platná technická.";
    item.checks = await hardenKind(item.checks, item, { cut: prices.cut, median: prices.median, judge: new ChecklistJudge({ router }), pageText, kind });
    return { prices, item: verdict(project.acceptanceResult.items, project.acceptance, project.checklist, kind).items.find((i: { url: string }) => i.url === url), result: verdict(project.acceptanceResult.items, project.acceptance, project.checklist, kind) };
  };

  it("the tyres on rims, far below the cut, are judged a second time with the prices and answered B: kind no, not confirmed", async () => {
    const project = copy();
    migrateChecks(project);
    const router = fakeRouter({ "kind-second": { kind: "B", span: "S1" } });
    const { prices, item, result } = await hardened(project, tyres, router);
    expect([prices.cut, prices.median]).toEqual([13100, 25000]);
    expect(router.userText("kind-second")).toContain("Price of this item: 2000 CZK\nMedian price of its comparable items: 25000 CZK");
    expect(item.checks.find((c: { clause: string }) => c.clause === "kind")).toMatchObject({ answer: "no", reason: LOW_PRICE_REASON });
    expect(item.tier).toBe("rejected");
    expect(result.validCount).toBe(1);
  });

  it("a real car at 10,000 CZK, below the cut, answered A stays a kind yes: the price alone decides nothing", async () => {
    const project = copy();
    const car = project.acceptanceResult.items.find((i: { value: number }) => i.value === 10000);
    car.checks = car.checks.map((c: { clause: string }) => (c.clause === "kind" ? { ...c, id: kindId, answer: "yes", quote: "Škoda Fabia 1.2 na prodej." } : { ...c, answer: "yes", quote: "stated on the page" }));
    const router = fakeRouter({ "kind-second": { kind: "A", span: "S1" } });
    const { item } = await hardened(project, car.url, router);
    expect(router.calls).toHaveLength(2);
    expect(item.checks.find((c: { clause: string }) => c.clause === "kind")).toMatchObject({ answer: "yes", quote: "Škoda Fabia 1.2 na prodej." });
    expect(item.tier).toBe("confirmed");
  });

  it("makes no extra call for an item at or above the cut", async () => {
    const project = copy();
    const router = fakeRouter({ "kind-second": { kind: "B", span: "S1" } });
    const fabia = project.acceptanceResult.items[0];
    const before = JSON.stringify(fabia.checks);
    const { item } = await hardened(project, fabia.url, router);
    expect(router.calls).toEqual([]);
    expect(JSON.stringify(project.acceptanceResult.items[0].checks)).toBe(before);
    expect(item.tier).toBe("confirmed");
  });
});
