// describeResolverContract — the RouteResolver contract as executable tests.
//
// A private resolver is developed OUTSIDE this repo, against `RouteResolver` in
// `./index`. Contract drift there only shows up in production, so the open side
// has to ship the expectations, not just the interface: run these cases in your
// own suite and a pass means your resolver honours the documented contract.
//
//   const resolver = new MyResolver(...);
//   describeResolverContract("MyResolver", () => resolver);
//
// The four cases, and why each one is on the list:
//
//   1. a decision carries a receiving anchor — the engine pays into
//      `decision.receiving`, so a decision without one is a payment with no
//      destination.
//   2. the same intent twice resolves to the same anchor domain — a process
//      that restarts mid-payment re-resolves, and a resolver that changes its
//      mind settles the second half somewhere else. Resume safety.
//   3. failure behaviour matches what the resolver documents — either it
//      refuses, or it resolves with the `trust` it says it will. Silently
//      falling back to a weaker source of truth is the failure this seam exists
//      to prevent.
//   4. `split`, if present, sums to 1 — weights that don't add up route more
//      value than the payment holds.

import { describe, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";
import type { RouteDecision, RouteResolver } from "./index";
import { ALL_PRICE_LABELS, type AllowedPriceLabel } from "./label-policy";

/** The corridors and intent the suite hands to `makeResolver` and resolves with. */
export interface ResolverContractFixtures {
  /** The payment to route. */
  readonly intent: PaymentIntent;
  /** A corridor the resolver is expected to route. */
  readonly corridor: Corridor;
  /** A corridor the resolver is expected to refuse. */
  readonly unresolvableCorridor: Corridor;
}

/**
 * What the resolver must do with `unresolvableCorridor` — the one behaviour
 * that legitimately differs between the shipped resolvers.
 * `RegistryRouteResolver` refuses; `StaticRouteResolver` documents that it
 * trusts the manifest, and so resolves with `trust: "manifest"`.
 */
export type UnresolvableExpectation =
  | { readonly outcome: "rejects"; readonly errorPattern?: RegExp }
  | { readonly outcome: "resolves"; readonly trust: "attested" | "manifest" };

export interface ResolverContractOverrides extends Partial<ResolverContractFixtures> {
  readonly unresolvable?: UnresolvableExpectation;
  /**
   * How to read the anchor's home domain off a decision. Defaults to
   * `decision.receiving.name`, so build a test adapter whose `name` is the
   * domain the case 2 comparison is really about.
   */
  readonly domainOf?: (decision: RouteDecision) => string;
}

export interface ResolverContractResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ResolverContractReport {
  readonly resolver: string;
  readonly passed: boolean;
  readonly results: readonly ResolverContractResult[];
}

/** A resolver under test, built against the fixtures the suite will use. */
export type ResolverFactory = (
  fixtures: ResolverContractFixtures,
) => RouteResolver | Promise<RouteResolver>;

const DEST_DOMAIN = "resolved.example";
const UNRESOLVABLE_DOMAIN = "unresolvable.example";

function fixtureCorridor(id: string, homeDomain: string): Corridor {
  const parsed = parseCorridor({
    id,
    source: { name: "Sender", asset: "USDC", endpoints: { home_domain: "source.example" } },
    dest: { name: "Receiver", asset: "iso4217:ARS", endpoints: { home_domain: homeDomain } },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!parsed.ok)
    throw new Error(`fixture corridor ${id} is invalid: ${parsed.error.message}`);
  return parsed.value;
}

/** The fixtures used when a suite does not supply its own. */
export function resolverContractFixtures(): ResolverContractFixtures {
  return {
    intent: {
      idempotencyKey: "contract-1",
      corridorId: "contract",
      sender: { id: "sender" },
    } as PaymentIntent,
    corridor: fixtureCorridor("contract", DEST_DOMAIN),
    unresolvableCorridor: fixtureCorridor("contract-unresolvable", UNRESOLVABLE_DOMAIN),
  };
}

class ContractViolation extends Error {}

// A `function` declaration returning `never`, not an arrow assigned to a const:
// only the former makes the compiler treat the call as terminating, which is how
// the cases below read after they report a violation.
function violate(format: string, ...args: unknown[]): never {
  throw new ContractViolation(format.replace(/%s/g, () => String(args.shift())));
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

function receivingName(decision: RouteDecision): string {
  const adapter = decision.receiving as AnchorAdapter | undefined;
  return adapter && typeof adapter.name === "string" ? adapter.name : "<none>";
}

type Case = { readonly name: string; readonly run: () => Promise<string> };

function casesFor(
  makeResolver: ResolverFactory,
  fixtures: ResolverContractFixtures,
  opts: UnresolvableExpectation,
  domainOf: (decision: RouteDecision) => string,
): Case[] {
  const { intent, corridor, unresolvableCorridor } = fixtures;
  const resolver = async (): Promise<RouteResolver> => makeResolver(fixtures);

  return [
    {
      name: "a decision carries a receiving anchor",
      run: async () => {
        const r = await resolver();
        let decision: RouteDecision;
        try {
          decision = await r.resolve(intent, corridor);
        } catch (cause) {
          violate(
            `resolving ${corridor.dest.endpoints.home_domain} threw %s — a resolver that cannot route ` +
              `must say so through the failure behaviour it documents, not by crashing`,
            describeError(cause),
          );
        }
        if (!decision || typeof decision !== "object") {
          violate("resolve() returned %s, not a RouteDecision", String(decision));
        }
        if (!decision.receiving || typeof decision.receiving.name !== "string") {
          violate("resolve() returned a decision with no receiving anchor (no named adapter)");
        }
        if (decision.trust !== "attested" && decision.trust !== "manifest") {
          violate(
            `decision.trust is %s, which the contract does not define ("attested" or "manifest")`,
            JSON.stringify(decision.trust),
          );
        }
        return `${receivingName(decision)} via trust: ${decision.trust}`;
      },
    },
    {
      name: "the same intent twice yields the same anchor domain",
      run: async () => {
        const r = await resolver();
        const first = domainOf(await r.resolve(intent, corridor));
        const second = domainOf(await r.resolve(intent, corridor));
        if (first !== second) {
          violate(
            `one intent anchored two domains (${first} then ${second}); a payment that resumes after a ` +
              `restart would settle its second half somewhere else`,
          );
        }
        return `${first} on both calls`;
      },
    },
    {
      name: "failure behaviour matches what the resolver documents",
      run: async () => {
        const r = await resolver();
        const domain = unresolvableCorridor.dest.endpoints.home_domain;
        const errorPattern = opts.outcome === "rejects" ? opts.errorPattern : undefined;
        let settled: RouteDecision;
        try {
          settled = await r.resolve(intent, unresolvableCorridor);
        } catch (cause) {
          if (!(cause instanceof Error)) {
            violate(`refused ${domain} by throwing %s, not an Error`, describeError(cause));
          }
          if (errorPattern && !errorPattern.test(cause.message)) {
            violate(
              `refused ${domain} with "${cause.message}", which does not match ${String(
                errorPattern,
              )}`,
            );
          }
          return `refused ${domain} (${cause.message})`;
        }
        if (opts.outcome !== "resolves") {
          violate(
            `routed ${domain} to ${receivingName(settled)} when the documented behaviour is to refuse it`,
          );
        }
        if (settled.trust !== opts.trust) {
          violate(
            `routed ${domain} with trust: ${settled.trust}, not the documented ${opts.trust}`,
          );
        }
        return `resolved ${domain} with trust: ${opts.trust}, as documented`;
      },
    },
    {
      name: "split weights, if present, sum to 1",
      run: async () => {
        const r = await resolver();
        const decision = await r.resolve(intent, corridor);
        if (decision.split === undefined) {
          return "no split returned — nothing to sum";
        }
        if (!Array.isArray(decision.split) || decision.split.length === 0) {
          violate("split is present but empty or not an array");
        }
        let total = 0;
        for (const leg of decision.split) {
          if (!leg.adapter || typeof leg.weight !== "number" || !Number.isFinite(leg.weight)) {
            violate(`split leg ${JSON.stringify(leg)} has no adapter or no finite weight`);
          }
          if (leg.weight <= 0 || leg.weight > 1) {
            violate(`split leg ${leg.adapter.name} weighs ${leg.weight}, outside (0, 1]`);
          }
          total += leg.weight;
        }
        if (Math.abs(total - 1) > 1e-6) {
          violate(
            `split weights sum to ${total}, not 1 — that routes more value than the payment holds`,
          );
        }
        return `${decision.split.length} leg(s) summing to 1`;
      },
    },
  ];
}

/** Fixtures, expectations and cases for one resolver under test. */
function contractFor(
  makeResolver: ResolverFactory,
  overrides: ResolverContractOverrides,
): {
  readonly fixtures: ResolverContractFixtures;
  readonly cases: readonly Case[];
} {
  const base = resolverContractFixtures();
  const fixtures: ResolverContractFixtures = {
    intent: overrides.intent ?? base.intent,
    corridor: overrides.corridor ?? base.corridor,
    unresolvableCorridor: overrides.unresolvableCorridor ?? base.unresolvableCorridor,
  };
  const expectation = overrides.unresolvable ?? { outcome: "rejects" as const };
  const domainOf = overrides.domainOf ?? ((d: RouteDecision) => receivingName(d));
  return { fixtures, cases: casesFor(makeResolver, fixtures, expectation, domainOf) };
}

/**
 * Run the contract without registering it, for suites that want the report —
 * including the deliberately broken resolver in `tests/router.test.ts`.
 */
export async function checkResolverContract(
  resolverName: string,
  makeResolver: ResolverFactory,
  overrides: ResolverContractOverrides = {},
): Promise<ResolverContractReport> {
  const { cases } = contractFor(makeResolver, overrides);

  const results: ResolverContractResult[] = [];
  for (const c of cases) {
    try {
      results.push({ name: c.name, passed: true, detail: await c.run() });
    } catch (cause) {
      const detail =
        cause instanceof ContractViolation
          ? cause.message
          : `the case itself could not run: ${describeError(cause)}`;
      results.push({ name: c.name, passed: false, detail });
    }
  }
  return { resolver: resolverName, passed: results.every((r) => r.passed), results };
}

/** Throw, naming every case the resolver failed. */
export function expectResolverContract(report: ResolverContractReport): void {
  const failures = report.results.filter((r) => !r.passed);
  if (failures.length > 0) {
    throw new Error(
      `${report.resolver} violates the RouteResolver contract:\n` +
        failures.map((f) => `  - ${f.name}: ${f.detail}`).join("\n"),
    );
  }
}

/**
 * Register the contract as vitest cases, one per contract clause. Call this
 * from your own test file with your own resolver — that is the whole point of
 * shipping it here.
 */
export function describeResolverContract(
  resolverName: string,
  makeResolver: ResolverFactory,
  overrides: ResolverContractOverrides = {},
): void {
  describe(`RouteResolver contract: ${resolverName}`, () => {
    for (const c of contractFor(makeResolver, overrides).cases) {
      it(c.name, async () => {
        await c.run();
      });
    }
  });
}

// describePlannerContract — the route planner's contract as executable tests.
//
// A planner turns a payment's candidate routes into the options a sender is
// shown: some offered, in order, each carrying a price label; the rest dropped,
// each carrying the reason. The rules below are the planner's, not the
// resolver's, so they live in their own suite. As with `describeResolverContract`,
// run them in your own suite and a pass means your planner honours them:
//
//   describePlannerContract("MyPlanner", (fixtures) => new MyPlanner(...), {
//     input: myPlanInput,
//     unattestedDomains: ["not-attested.example"],
//   });
//
// The suite is structural: it needs `plan(input)` to return `{ offered, dropped }`
// and nothing else, so it does not tie a planner to any one input type.
//
// The four cases, and why each one is on the list:
//
//   1. an unattested option is never offered — an option nobody has vouched for
//      is the one a sender must never be shown as a way to pay.
//   2. every dropped option carries a reason — a route that vanishes without
//      one cannot be explained to the sender or debugged by the operator.
//   3. the same input yields the same order — the ranking has no hidden weights
//      and no randomness, so a re-plan cannot reshuffle what the sender saw.
//   4. every label is one of the three — "locked", "indicative" or "estimated".
//      A fourth label is a price the sender has no wording for.

/** One route the planner offers, in the position it ranks. */
export interface PlannedOption {
  /** The receiving anchor's home domain. */
  readonly domain: string;
  /** How firmly the price is held: the router's own `AllowedPriceLabel` (RFC 0004 §1). */
  readonly label: AllowedPriceLabel;
}

/** One route the planner ruled out, and why. */
export interface DroppedOption {
  readonly domain: string;
  readonly reason: string;
}

/** What a planner returns: the ranked offers and everything it ruled out. */
export interface PlanOutcome {
  readonly offered: readonly PlannedOption[];
  readonly dropped: readonly DroppedOption[];
}

/** The part of a planner the contract exercises. */
export interface PlannerUnderTest<TInput> {
  plan(input: TInput): PlanOutcome | Promise<PlanOutcome>;
}

/** What the suite plans with. A planner has no default input, so both are required. */
export interface PlannerContractFixtures<TInput> {
  /** An input whose candidates include at least one of `unattestedDomains`. */
  readonly input: TInput;
  /** Home domains in `input` that are not attested and so must never be offered. */
  readonly unattestedDomains: readonly string[];
}

/** A planner under test, built against the fixtures the suite will use. */
export type PlannerFactory<TInput> = (
  fixtures: PlannerContractFixtures<TInput>,
) => PlannerUnderTest<TInput> | Promise<PlannerUnderTest<TInput>>;

export interface PlannerContractResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PlannerContractReport {
  readonly planner: string;
  readonly passed: boolean;
  readonly results: readonly PlannerContractResult[];
}

async function planOnce<TInput>(
  planner: PlannerUnderTest<TInput>,
  input: TInput,
): Promise<PlanOutcome> {
  let outcome: PlanOutcome;
  try {
    outcome = await planner.plan(input);
  } catch (cause) {
    violate(
      "plan() threw %s — a planner with nothing to offer returns an empty `offered` and says why in `dropped`",
      describeError(cause),
    );
  }
  if (!outcome || !Array.isArray(outcome.offered) || !Array.isArray(outcome.dropped)) {
    violate(
      "plan() did not return { offered: [], dropped: [] }, got %s",
      JSON.stringify(outcome),
    );
  }
  return outcome;
}

function plannerCasesFor<TInput>(
  makePlanner: PlannerFactory<TInput>,
  fixtures: PlannerContractFixtures<TInput>,
): Case[] {
  const planner = async (): Promise<PlannerUnderTest<TInput>> => makePlanner(fixtures);
  const run = async (): Promise<PlanOutcome> => planOnce(await planner(), fixtures.input);

  return [
    {
      name: "an unattested option is never offered",
      run: async () => {
        if (fixtures.unattestedDomains.length === 0) {
          violate(
            "the fixtures name no unattested domain, so this case would prove nothing; " +
              "supply at least one in `unattestedDomains`",
          );
        }
        const { offered } = await run();
        const unattested = new Set(fixtures.unattestedDomains);
        const leaked = offered.filter((o) => unattested.has(o.domain)).map((o) => o.domain);
        if (leaked.length > 0) {
          violate(
            `offered unattested domain(s) ${leaked.join(", ")}; an option no one has vouched for ` +
              `must be dropped, not shown to the sender`,
          );
        }
        return `${offered.length} offered, none of ${fixtures.unattestedDomains.length} unattested`;
      },
    },
    {
      name: "every dropped option carries a reason",
      run: async () => {
        const { dropped } = await run();
        for (const d of dropped) {
          if (!d || typeof d.domain !== "string" || d.domain === "") {
            violate(`a dropped option has no domain: ${JSON.stringify(d)}`);
          }
          if (typeof d.reason !== "string" || d.reason.trim() === "") {
            violate(
              `${d.domain} was dropped with no reason; a route that vanishes unexplained cannot ` +
                `be shown to the sender or debugged by the operator`,
            );
          }
        }
        return `${dropped.length} dropped, each with a reason`;
      },
    },
    {
      name: "the same input yields the same order",
      run: async () => {
        const p = await planner();
        const order = async (): Promise<string[]> =>
          (await planOnce(p, fixtures.input)).offered.map((o) => `${o.domain}:${o.label}`);
        const first = await order();
        const second = await order();
        if (first.join(" > ") !== second.join(" > ")) {
          violate(
            `the same input ranked as [${first.join(", ")}] then [${second.join(", ")}]; ` +
              `a re-plan must not reshuffle what the sender already saw`,
          );
        }
        return `${first.length} option(s) in the same order on both calls`;
      },
    },
    {
      name: "every label is locked, indicative or estimated",
      run: async () => {
        const { offered } = await run();
        for (const o of offered) {
          if (!ALL_PRICE_LABELS.includes(o.label)) {
            violate(
              `${o.domain} is labelled %s, which the contract does not define ` +
                `(locked, indicative or estimated)`,
              JSON.stringify(o.label),
            );
          }
        }
        return `${offered.length} option(s), all with a defined label`;
      },
    },
  ];
}

/**
 * Run the planner contract without registering it, for suites that want the
 * report — including one that proves a deliberately broken planner fails it.
 */
export async function checkPlannerContract<TInput>(
  plannerName: string,
  makePlanner: PlannerFactory<TInput>,
  fixtures: PlannerContractFixtures<TInput>,
): Promise<PlannerContractReport> {
  const results: PlannerContractResult[] = [];
  for (const c of plannerCasesFor(makePlanner, fixtures)) {
    try {
      results.push({ name: c.name, passed: true, detail: await c.run() });
    } catch (cause) {
      const detail =
        cause instanceof ContractViolation
          ? cause.message
          : `the case itself could not run: ${describeError(cause)}`;
      results.push({ name: c.name, passed: false, detail });
    }
  }
  return { planner: plannerName, passed: results.every((r) => r.passed), results };
}

/** Throw, naming every case the planner failed. */
export function expectPlannerContract(report: PlannerContractReport): void {
  const failures = report.results.filter((r) => !r.passed);
  if (failures.length > 0) {
    throw new Error(
      `${report.planner} violates the planner contract:\n` +
        failures.map((f) => `  - ${f.name}: ${f.detail}`).join("\n"),
    );
  }
}

/** Register the planner contract as vitest cases, one per clause. */
export function describePlannerContract<TInput>(
  plannerName: string,
  makePlanner: PlannerFactory<TInput>,
  fixtures: PlannerContractFixtures<TInput>,
): void {
  describe(`Planner contract: ${plannerName}`, () => {
    for (const c of plannerCasesFor(makePlanner, fixtures)) {
      it(c.name, async () => {
        await c.run();
      });
    }
  });
}
