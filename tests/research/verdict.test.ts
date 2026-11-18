import { describe, it, expect } from "vitest";
import { itemTier, itemEvidence, verdict, verdictInvariants, hardIdsOf, qualifies, acceptanceSummaryOf, runOutcome, headlineOf, scoreOf, verdictReport, verdictLines } from "../../src/research/verdict.mjs";
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

describe("the single headline owner (C9, C10; from origin/fix/honest-headline c50e86c, 60c162b)", () => {
  const checklist = [{ clause: "sells in bulk", items: [{ hard: true, question: "q1" }] }];
  const id = "sells in bulk|q1";
  const item = (url: string, check: object | null, overrides = {}) => ({ url, title: url, live: true, listing: true, inRange: true, purpose: [], checks: check ? [{ id, clause: "sells in bulk", hard: true, ...check }] : [], ...overrides });
  const items = [
    item("https://a.test/", { answer: "yes", quote: "minimum order 500 kg" }),
    item("https://b.test/", { answer: "no", quote: "retail shop, single pieces only" }),
    item("https://c.test/", { answer: "unknown", reason: "the page states no order size" }),
    item("https://d.test/", null),
    item("https://e.test/", { answer: "yes", quote: "bales of 45 kg" }, { live: false }),
  ];
  const spec = { itemCount: 20, urlsLive: true, valueRange: [0, 50], unit: "EUR/kg", mustMention: [] };
  const computed = verdict(items, spec, checklist);
  const checks = [
    { id: "count", label: "At least 20 valid items", value: 0.05, passed: false, detail: "1 of 5 delivered pass every check" },
    { id: "live", label: "Links open a real page", value: 1, passed: true, detail: "4 of 5 checked links are live" },
    { id: "range", label: "Value within 0–50 EUR/kg", value: 1, passed: true, detail: "5 of 5 pages show a value in range" },
    { id: `checklist-${id}`, label: "Checklist: sells in bulk", value: 0.5, passed: false, detail: "2 of 4 checked items pass this hard check" },
  ];
  const project = { acceptance: spec, checklist, acceptanceResult: { score: scoreOf(checks), checks, items: computed.items, totalAsked: 20, validCount: computed.validCount, verdict: computed } };

  it("the headline counts the items that meet every must-have out of the number asked, with the reachable count beside it", () => {
    expect(headlineOf({ tiers: { confirmed: 2, toConfirm: 3, rejected: 5, notJudged: 10 }, asked: 20 })).toEqual({ headline: "2 of 20 meet every must-have", upTo: "up to 5 of 20 could meet every must-have (2 confirmed + 3 to confirm)", confirmed: 2, toConfirm: 3, asked: 20 });
    expect(headlineOf({ tiers: { confirmed: 15, toConfirm: 30, rejected: 0, notJudged: 0 }, asked: 20 }).upTo).toBe("up to 20 of 20 could meet every must-have (15 confirmed + 30 to confirm)");
    expect(headlineOf({ tiers: { confirmed: 30, toConfirm: 4, rejected: 0, notJudged: 0 }, asked: 20 })).toMatchObject({ headline: "30 of 20 meet every must-have", upTo: "" });
  });

  it("a mean of unrelated checks is never the headline: checks averaging 64% with 1 of 20 confirmed read '1 of 20'", () => {
    const report = verdictReport(project)!;
    expect(Math.round(project.acceptanceResult.score * 100)).toBe(64);
    expect(report.headline).toBe("1 of 20 meet every must-have");
    expect(report.upTo).toBe("up to 2 of 20 could meet every must-have (1 confirmed + 1 to confirm)");
    expect(verdictLines(report).join(" ")).not.toContain("64%");
  });

  it("requirements carry their share and counts; count, links and range are preconditions listed apart", () => {
    const report = verdictReport(project)!;
    expect(report.requirements).toEqual([{ id: `checklist-${id}`, label: "sells in bulk", share: 0.5, detail: "2 of 4 checked items pass this hard check", yes: 2, no: 1, unknown: 1, judged: 4 }]);
    expect(report.preconditions.map((c) => c.id)).toEqual(["count", "live", "range"]);
    expect(report.requirements.some((r) => ["count", "live", "range", "mentions"].includes(r.id))).toBe(false);
  });

  it("every item states the quote or the reason per requirement, so an excluded or open item says why", () => {
    const byUrl = new Map(verdictReport(project)!.items.map((entry) => [entry.url, entry]));
    expect(byUrl.get("https://a.test/")).toMatchObject({ tier: "confirmed", reasons: [{ requirement: "sells in bulk", answer: "yes", quote: "minimum order 500 kg" }] });
    expect(byUrl.get("https://b.test/")).toMatchObject({ tier: "rejected", reasons: [{ answer: "no", quote: "retail shop, single pieces only" }] });
    expect(byUrl.get("https://c.test/")).toMatchObject({ tier: "to-confirm", reasons: [{ answer: "unknown", reason: "the page states no order size" }] });
    expect(byUrl.get("https://d.test/")).toMatchObject({ tier: "not-judged", reasons: [{ requirement: id, answer: "not judged", reason: "the page was not read" }] });
    expect(byUrl.get("https://e.test/")!.reasons[0]).toEqual({ requirement: "the link opens a page", answer: "no", quote: "", reason: "the page did not open" });
  });

  it("a research that asked for no number of items states how many checks pass, and no result means no headline", () => {
    const memoOnly = { acceptance: { mustMention: ["permit"] }, acceptanceResult: { score: 0.5, checks: [{ id: "mentions", label: "Pages mention: permit", value: 0.5, passed: false, detail: "share of required terms found on the pages" }], items: [], totalAsked: 0 } };
    expect(verdictReport(memoOnly)).toMatchObject({ headline: "0 of 1 expected-result checks pass", upTo: "", requirements: [] });
    expect(verdictReport({ acceptance: { itemCount: 3 } })).toBeNull();
    expect(verdictReport(memoOnly)!.recheckCancelled).toBe("");
    expect(verdictReport({ ...memoOnly, acceptanceRecheck: { cancelled: true, at: "2026-11-18T20:00:00.000Z" } })!.recheckCancelled).toBe("a later re-check was cancelled at 2026-11-18T20:00:00.000Z; this is the last complete result");
    expect(verdictLines(null)).toEqual([]);
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

  it("a no from one provider family alone rejects nothing: the item stays in the list, to confirm", async () => {
    const project = copy();
    migrateChecks(project);
    const tyresItem = project.acceptanceResult.items.find((i: { url: string }) => i.url === tyres);
    tyresItem.checks = tyresItem.checks.map((c: { clause: string }) => (c.clause === "kind" ? { ...c, id: kindId, answer: "yes", quote: "Zimní pneu na plechových discích." } : { ...c, answer: "yes", quote: "stated on the page" }));
    const router = fakeRouter({ "kind-second": { kind: "B", span: "S1" } }, { providers: ["p1"] });
    const { item, result } = await hardened(project, tyres, router);
    expect(router.calls).toHaveLength(2);
    expect(item.checks.find((c: { clause: string }) => c.clause === "kind")).toMatchObject({ answer: "unknown", second: { answer: "unknown", single: true } });
    expect(item.tier).toBe("to-confirm");
    expect(result.items.some((i: { url: string }) => i.url === tyres)).toBe(true);
    const voted = copy();
    migrateChecks(voted);
    const votedItem = voted.acceptanceResult.items.find((i: { url: string }) => i.url === tyres);
    votedItem.checks = tyresItem.checks.map((c: { clause: string }) => (c.clause === "kind" ? { ...c, answer: "yes", second: undefined, reason: undefined } : c));
    const two = await hardened(voted, tyres, fakeRouter({ "kind-second": { kind: "B", span: "S1" } }));
    expect(two.item.tier).toBe("rejected");
    expect(result.tiers.rejected).toBe(two.result.tiers.rejected - 1);
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

describe("purpose gate", () => {
  const kindId = "kind|Is this page one wholesale clothing supplier offered as asked?";
  const item = (kindAnswer: { answer: string; quote: string }) => ({
    live: true,
    evidence: "https://hub.example/list",
    purpose: [{ id: "purpose-names-1", passed: true }, { id: "purpose-kind", passed: false }],
    checks: [{ id: kindId, clause: "kind", hard: true, ...kindAnswer }],
  });

  it("accepts the asked kind on a page in another language when the kind judge quoted the page", () => {
    expect(qualifies(item({ answer: "yes", quote: "Groothandel in tweedehands kleding" }), {})).toBe(true);
  });

  it("still rejects the page when the kind judge did not confirm it with a quote", () => {
    expect(qualifies(item({ answer: "yes", quote: "" }), {})).toBe(false);
    expect(qualifies(item({ answer: "unknown", quote: "" }), {})).toBe(false);
  });

  it("never lets the kind judge stand in for a failed names check", () => {
    const failedNames = { ...item({ answer: "yes", quote: "Groothandel" }), purpose: [{ id: "purpose-names-1", passed: false }] };
    expect(qualifies(failedNames, {})).toBe(false);
  });
});

describe("runOutcome", () => {
  const done = (totalAsked: number, validCount: number) => ({ phase: "done", acceptanceResult: { totalAsked, validCount } });

  it("is short when a finished research delivered fewer items than asked", () => {
    expect(runOutcome(done(20, 1))).toEqual({ state: "short", confirmed: 1, asked: 20 });
  });

  it("is met when every asked item is confirmed, or no count was asked", () => {
    expect(runOutcome(done(20, 20)).state).toBe("met");
    expect(runOutcome(done(0, 0)).state).toBe("met");
    expect(runOutcome({ phase: "done" }).state).toBe("met");
  });

  it("keeps the phase while the research has not finished", () => {
    expect(runOutcome({ phase: "researching", acceptanceResult: { totalAsked: 20, validCount: 1 } }).state).toBe("researching");
  });
});

describe('a hard check that was never answered', () => {
  const hardIds = ['a|is it a?', 'b|is it b?'];
  const item = { live: true, listing: true, checks: [{ id: 'a|is it a?', hard: true, answer: 'yes', quote: 'it is a' }] };

  it('leaves the item to confirm and lists the check as open, instead of confirming it by silence', () => {
    expect(itemTier(item, hardIds, {})).toBe('to-confirm');
    expect(itemEvidence(item, hardIds, {}).open).toEqual(['b|is it b?']);
    expect(itemTier({ ...item, checks: [...item.checks, { id: 'b|is it b?', hard: true, answer: 'yes', quote: 'it is b' }] }, hardIds, {})).toBe('confirmed');
    expect(itemTier({ ...item, checks: [] }, hardIds, {})).toBe('not-judged');
  });
});

describe('an item whose page could not be judged', () => {
  it('is not judged, never to confirm or rejected, while every hard check is marked not judged', () => {
    const hardIds = ['a|is it a?', 'b|is it b?'];
    const unread = { live: true, listing: true, checks: hardIds.map((id) => ({ id, hard: true, answer: 'unknown', quote: '', notJudged: true })) };
    expect(itemTier(unread, hardIds, {})).toBe('not-judged');
    expect(itemTier({ ...unread, checks: [unread.checks[0], { id: 'b|is it b?', hard: true, answer: 'yes', quote: 'it is b' }] }, hardIds, {})).toBe('to-confirm');
  });
});
