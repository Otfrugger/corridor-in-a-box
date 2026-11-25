// Turns a RouteDecision into the record the audit trail keeps about it, so
// "why did this payment go through anchor X?" has an answer in the
// append-only trail rather than only in a resolver's logs.
//
// Bounded on purpose: a third-party resolver controls these strings, and the
// trail is append-only, so at most three options, five reasons each, and 200
// characters per string are kept, and only the three RFC 0004 price labels.

import {
  ALL_PRICE_LABELS,
  type AllowedPriceLabel,
  type RouteDecision,
} from "@corridor/router";
import type { RouteChoice, RouteChoiceOption } from "./observability";

/** How many options the trail keeps. */
export const ROUTE_CHOICE_TOP_N = 3;
const MAX_REASONS = 5;
const MAX_TEXT = 200;

function text(value: unknown): string {
  const s = typeof value === "string" ? value : String(value);
  return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT - 1)}…`;
}

function rankOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** The value as an RFC 0004 price label, or undefined for anything else. */
function priceLabelOf(value: unknown): AllowedPriceLabel | undefined {
  return (ALL_PRICE_LABELS as readonly unknown[]).includes(value)
    ? (value as AllowedPriceLabel)
    : undefined;
}

/**
 * The audit record for a route decision.
 *
 * With a `ranking`, the chosen option is the one whose id matches
 * `ranking.chosen`, and `top` is the best three by rank (ties keep the
 * resolver's order). Without one — or when the chosen id is not among the
 * options — the receiving adapter is recorded as the single, rank-1 option.
 *
 * `runPriceLabel` is the price label of the run's own quote. It labels the
 * chosen option when the resolver gave it no valid label (always the case
 * without a ranking). A label outside `locked` / `indicative` / `estimated`
 * is dropped, never recorded.
 */
export function routeChoiceFor(
  decision: RouteDecision,
  runPriceLabel?: AllowedPriceLabel,
): RouteChoice {
  const options = decision.ranking?.options ?? [];
  const chosen = options.find((o) => o.id === decision.ranking?.chosen);
  const fallbackLabel = priceLabelOf(runPriceLabel);

  if (!chosen) {
    const id = text(decision.receiving.name);
    const only: RouteChoiceOption = {
      id,
      ...(fallbackLabel && { label: fallbackLabel }),
      rank: 1,
      reasons: [`single option from resolver (trust: ${decision.trust})`],
    };
    return {
      chosen: { id, ...(fallbackLabel && { label: fallbackLabel }), rank: 1 },
      top: [only],
    };
  }

  const top = options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rankOf(a.o.rank) - rankOf(b.o.rank) || a.i - b.i)
    .slice(0, ROUTE_CHOICE_TOP_N)
    .map(({ o }): RouteChoiceOption => {
      const label = priceLabelOf(o.label);
      return {
        id: text(o.id),
        ...(label && { label }),
        rank: rankOf(o.rank),
        reasons: (Array.isArray(o.reasons) ? o.reasons : []).slice(0, MAX_REASONS).map(text),
      };
    });

  const chosenLabel = priceLabelOf(chosen.label) ?? fallbackLabel;
  return {
    chosen: {
      id: text(chosen.id),
      ...(chosenLabel && { label: chosenLabel }),
      rank: rankOf(chosen.rank),
    },
    top,
  };
}
