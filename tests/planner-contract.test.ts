import { describe, expect, it } from "vitest";
import type { AllowedPriceLabel } from "@corridor/router";
import {
  checkPlannerContract,
  describePlannerContract,
  expectPlannerContract,
  type PlanOutcome,
  type PlannerContractFixtures,
  type PlannerUnderTest,
} from "@corridor/router/testing";

// A candidate route as the stub planner sees it. The contract is structural, so
// this stands in for whatever input a real planner takes.
interface Candidate {
  readonly domain: string;
  readonly attested: boolean;
  readonly label: AllowedPriceLabel;
  readonly receives: number;
}

const candidates: readonly Candidate[] = [
  { domain: "b.example", attested: true, label: "indicative", receives: 98 },
  { domain: "rogue.example", attested: false, label: "locked", receives: 120 },
  { domain: "a.example", attested: true, label: "locked", receives: 97 },
  { domain: "c.example", attested: true, label: "estimated", receives: 98 },
];

const fixtures: PlannerContractFixtures<readonly Candidate[]> = {
  input: candidates,
  unattestedDomains: ["rogue.example"],
};

/** Offers attested routes, best-for-recipient first, ties by domain; drops the rest with a reason. */
class StubPlanner implements PlannerUnderTest<readonly Candidate[]> {
  plan(input: readonly Candidate[]): PlanOutcome {
    const offered = input
      .filter((c) => c.attested)
      .sort((x, y) => y.receives - x.receives || x.domain.localeCompare(y.domain))
      .map((c) => ({ domain: c.domain, label: c.label }));
    const dropped = input
      .filter((c) => !c.attested)
      .map((c) => ({ domain: c.domain, reason: "dropped: not attested for this lane" }));
    return { offered, dropped };
  }
}

// --- the contract, executable, over a conforming planner --------------------

describePlannerContract("StubPlanner", () => new StubPlanner(), fixtures);

// --- each clause can actually fail ------------------------------------------

/** A planner that behaves like the stub, with one clause deliberately broken. */
function broken(
  patch: (outcome: PlanOutcome, call: number) => PlanOutcome,
): () => PlannerUnderTest<readonly Candidate[]> {
  return () => {
    const inner = new StubPlanner();
    let call = 0;
    return { plan: (input) => patch(inner.plan(input), call++) };
  };
}

async function failuresOf(
  name: string,
  make: () => PlannerUnderTest<readonly Candidate[]>,
  f: PlannerContractFixtures<readonly Candidate[]> = fixtures,
): Promise<string[]> {
  const report = await checkPlannerContract(name, make, f);
  return report.results.filter((r) => !r.passed).map((r) => r.name);
}

describe("describePlannerContract catches a planner that breaks a clause", () => {
  it("passes a conforming planner with every case", async () => {
    const report = await checkPlannerContract(
      "StubPlanner",
      () => new StubPlanner(),
      fixtures,
    );
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(4);
    expect(() => expectPlannerContract(report)).not.toThrow();
  });

  it("fails a planner that offers an unattested option", async () => {
    const make = broken((o) => ({
      ...o,
      offered: [...o.offered, { domain: "rogue.example", label: "locked" }],
    }));
    expect(await failuresOf("Leaky", make)).toEqual(["an unattested option is never offered"]);
  });

  it("fails a planner that drops an option without a reason", async () => {
    const make = broken((o) => ({
      ...o,
      dropped: o.dropped.map((d) => ({ domain: d.domain, reason: "  " })),
    }));
    expect(await failuresOf("Silent", make)).toEqual([
      "every dropped option carries a reason",
    ]);
  });

  it("fails a planner whose order changes between calls", async () => {
    const make = broken((o, call) => ({
      ...o,
      offered: call % 2 === 0 ? o.offered : [...o.offered].reverse(),
    }));
    expect(await failuresOf("Shuffler", make)).toEqual([
      "the same input yields the same order",
    ]);
  });

  it("fails a planner that invents a fourth label", async () => {
    const make = broken((o) => ({
      ...o,
      offered: o.offered.map((x) => ({ ...x, label: "guaranteed" as never })),
    }));
    expect(await failuresOf("Inventive", make)).toEqual([
      "every label is locked, indicative or estimated",
    ]);
  });

  it("fails a planner that throws instead of returning an outcome", async () => {
    const make = (): PlannerUnderTest<readonly Candidate[]> => ({
      plan: () => {
        throw new Error("no routes");
      },
    });
    expect(await failuresOf("Thrower", make)).toHaveLength(4);
  });

  it("refuses fixtures that name no unattested domain, rather than pass vacuously", async () => {
    const names = await failuresOf("Vacuous", () => new StubPlanner(), {
      input: candidates,
      unattestedDomains: [],
    });
    expect(names).toEqual(["an unattested option is never offered"]);
  });

  it("names every violated clause when expectPlannerContract throws", async () => {
    const make = broken((o) => ({
      offered: [...o.offered, { domain: "rogue.example", label: "locked" }],
      dropped: o.dropped.map((d) => ({ domain: d.domain, reason: "" })),
    }));
    const report = await checkPlannerContract("Both", make, fixtures);
    expect(() => expectPlannerContract(report)).toThrow(
      /Both violates the planner contract[\s\S]*unattested option[\s\S]*carries a reason/,
    );
  });
});
