// Where a sent payment stands, as five steps a sender can follow.
//
// The engine walks seventeen states (packages/engine/src/state.ts); a sender
// watching a payment arrive cares about five of them. GET /payments/:key only
// reports the CURRENT state, so once a run has failed or been refunded the state
// alone no longer says how far it got; the poller carries the furthest progress
// it has seen and folds each new status into it with `advance`.
//
// Pure and self-contained (structural types only) so the mapping is unit-tested
// from the repo's root suite (tests/web-payment-timeline.test.ts).

export const TIMELINE_STEPS = ["quoted", "compliant", "opened", "settled", "completed"] as const;

export type TimelineStep = (typeof TIMELINE_STEPS)[number];

export type TimelineStepStatus = "done" | "active" | "pending" | "stopped";

export type TimelineOutcome =
  | "in_progress"
  | "completed"
  | "recovering"
  | "refund_pending"
  | "refunded"
  | "held"
  | "failed";

/** The fields of a GET /payments/:key body the timeline reads. */
export interface PaymentStatusLike {
  state: string;
  stellarTxHash?: string;
  error?: string;
}

/** How many of the five steps each forward state has reached. */
const STEPS_REACHED: Record<string, number> = {
  created: 0,
  quoted: 1,
  compliant: 2,
  opened: 3,
  funding: 3,
  funded: 3,
  verifying: 3,
  settling: 3,
  retrying: 3,
  settled: 4,
  reconciled: 4,
  completed: 5,
};

const OUTCOMES: Record<string, TimelineOutcome> = {
  completed: "completed",
  recovering: "recovering",
  refund_pending: "refund_pending",
  refunded: "refunded",
  held: "held",
  failed: "failed",
};

/** The engine's terminal states: polling stops once one is reported. */
export function isFinalState(state: string): boolean {
  return state === "completed" || state === "refunded" || state === "held" || state === "failed";
}

export function outcomeOf(state: string): TimelineOutcome {
  return OUTCOMES[state] ?? "in_progress";
}

/**
 * Fold one polled status into the progress seen so far. Off-path states
 * (recovering, refunds, held, failed) carry no position of their own, so they
 * keep the previous progress; a settlement hash proves the settle step was
 * reached even if no earlier poll saw it.
 */
export function advance(previous: number, status: PaymentStatusLike): number {
  const own = STEPS_REACHED[status.state] ?? 0;
  const settled = status.stellarTxHash ? STEPS_REACHED.settled : 0;
  return Math.max(previous, own, settled);
}

/** Each step's status for a run that has reached `progress` steps and is in `state`. */
export function timelineSteps(
  progress: number,
  state: string,
): { step: TimelineStep; status: TimelineStepStatus }[] {
  const outcome = outcomeOf(state);
  return TIMELINE_STEPS.map((step, i) => {
    if (i < progress) return { step, status: "done" };
    if (i > progress) return { step, status: "pending" };
    return { step, status: outcome === "in_progress" ? "active" : "stopped" };
  });
}

/** One line for the live region and the outcome banner. */
export const OUTCOME_TEXT: Record<TimelineOutcome, string> = {
  in_progress: "Payment in progress",
  completed: "Payment completed",
  recovering: "Payment could not proceed; recovering funds",
  refund_pending: "Refund requested; waiting for the anchor",
  refunded: "Payment refunded to the sender",
  held: "Payment held for manual review",
  failed: "Payment failed",
};

export const STEP_TEXT: Record<TimelineStepStatus, string> = {
  done: "done",
  active: "in progress",
  pending: "not reached",
  stopped: "stopped here",
};
