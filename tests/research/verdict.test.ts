import { describe, it, expect } from "vitest";
import { itemTier, itemEvidence, verdict, verdictInvariants } from "../../src/research/verdict.mjs";
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
      qualifies: false,
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
    
    const item2 = baseItem({ qualifies: false, checks: [] });
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
});
