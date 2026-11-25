export const DEFAULT_PARALLEL_DEADLINE_MS = 5_000;

export interface ParallelPricingCandidate {
  receivingDomain: string;
  protocol?: string;
}

export interface PriceAnchorContext {
  signal: AbortSignal;
  timeoutMs: number;
  deadlineAtMs: number;
}

export type PriceCandidateFn<TCandidate extends ParallelPricingCandidate, TPrice> = (
  candidate: TCandidate,
  context: PriceAnchorContext,
) => Promise<TPrice>;

export interface ParallelPricingOptions {
  deadlineMs?: number;
  perAnchorTimeoutMs?: number;
  now?: () => number;
}

export interface PricedCandidateResult<TCandidate extends ParallelPricingCandidate, TPrice> {
  candidate: TCandidate;
  status: "priced";
  option: TPrice;
  elapsedMs: number;
}

export interface DroppedCandidateResult<TCandidate extends ParallelPricingCandidate> {
  candidate: TCandidate;
  status: "dropped";
  reason: string;
  timedOut: boolean;
  elapsedMs: number;
}

export interface ParallelPricingResult<TCandidate extends ParallelPricingCandidate, TPrice> {
  priced: Array<PricedCandidateResult<TCandidate, TPrice>>;
  dropped: Array<DroppedCandidateResult<TCandidate>>;
  deadlineMs: number;
  perAnchorTimeoutMs: number;
  timedOutCount: number;
}

/**
 * Formats a timeout duration into a human-readable drop reason such as
 * `"no price within 5 s"`.
 */
export function formatNoPriceWithinReason(timeoutMs: number): string {
  if (timeoutMs < 1_000 && timeoutMs % 1_000 !== 0) {
    return `no price within ${timeoutMs} ms`;
  }
  const seconds = timeoutMs / 1_000;
  const formattedSeconds = Number.isInteger(seconds)
    ? String(seconds)
    : Number(seconds.toFixed(2)).toString();
  return `no price within ${formattedSeconds} s`;
}

function validatePositiveMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number of ms`);
  }
  return value;
}

/**
 * Prices all candidate anchors concurrently, settling within an overall deadline
 * and per-anchor timeouts. Anchors that do not respond in time are dropped with
 * a `"no price within <N> s"` reason instead of delaying the remaining batch.
 */
export async function priceCandidatesInParallel<
  TCandidate extends ParallelPricingCandidate,
  TPrice,
>(
  candidates: readonly TCandidate[],
  priceCandidate: PriceCandidateFn<TCandidate, TPrice>,
  options?: ParallelPricingOptions,
): Promise<ParallelPricingResult<TCandidate, TPrice>> {
  const deadlineMs = validatePositiveMs(
    options?.deadlineMs ?? DEFAULT_PARALLEL_DEADLINE_MS,
    "deadlineMs",
  );
  const perAnchorTimeoutMs = validatePositiveMs(
    options?.perAnchorTimeoutMs ?? deadlineMs,
    "perAnchorTimeoutMs",
  );
  const now = options?.now ?? (() => Date.now());

  if (candidates.length === 0) {
    return {
      priced: [],
      dropped: [],
      deadlineMs,
      perAnchorTimeoutMs,
      timedOutCount: 0,
    };
  }

  const batchStartedAt = now();
  const overallDeadlineAt = batchStartedAt + deadlineMs;
  const slots = new Array<
    PricedCandidateResult<TCandidate, TPrice> | DroppedCandidateResult<TCandidate>
  >(candidates.length);
  const perAnchorTimers = new Set<ReturnType<typeof setTimeout>>();

  let overallTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    await new Promise<void>((resolveAll) => {
      let remaining = candidates.length;
      const settles: Array<(timedOut: boolean, reason: string) => void> = [];

      const markDone = () => {
        remaining -= 1;
        if (remaining === 0) {
          resolveAll();
        }
      };

      overallTimer = setTimeout(() => {
        const deadlineReason = formatNoPriceWithinReason(deadlineMs);
        for (const settleTimeout of settles) {
          settleTimeout(true, deadlineReason);
        }
      }, deadlineMs);

      candidates.forEach((candidate, index) => {
        const controller = new AbortController();
        const anchorTimeoutMs = Math.min(perAnchorTimeoutMs, deadlineMs);
        let settled = false;
        let anchorTimer: ReturnType<typeof setTimeout> | undefined;

        const cleanupTimer = () => {
          if (anchorTimer !== undefined) {
            clearTimeout(anchorTimer);
            perAnchorTimers.delete(anchorTimer);
            anchorTimer = undefined;
          }
        };

        const finalizeDropped = (timedOut: boolean, reason: string) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanupTimer();
          if (timedOut) {
            controller.abort(new Error(reason));
          }
          slots[index] = {
            candidate,
            status: "dropped",
            reason,
            timedOut,
            elapsedMs: Math.max(0, now() - batchStartedAt),
          };
          markDone();
        };

        settles.push(finalizeDropped);

        anchorTimer = setTimeout(() => {
          finalizeDropped(true, formatNoPriceWithinReason(anchorTimeoutMs));
        }, anchorTimeoutMs);
        perAnchorTimers.add(anchorTimer);

        let pending: Promise<TPrice>;
        try {
          pending = Promise.resolve(
            priceCandidate(candidate, {
              signal: controller.signal,
              timeoutMs: anchorTimeoutMs,
              deadlineAtMs: overallDeadlineAt,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finalizeDropped(false, message);
          return;
        }

        pending.then(
          (option) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanupTimer();
            slots[index] = {
              candidate,
              status: "priced",
              option,
              elapsedMs: Math.max(0, now() - batchStartedAt),
            };
            markDone();
          },
          (err: unknown) => {
            if (settled) {
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            finalizeDropped(false, message);
          },
        );
      });
    });
  } finally {
    if (overallTimer !== undefined) {
      clearTimeout(overallTimer);
    }
    for (const timer of perAnchorTimers) {
      clearTimeout(timer);
    }
    perAnchorTimers.clear();
  }

  const priced: Array<PricedCandidateResult<TCandidate, TPrice>> = [];
  const dropped: Array<DroppedCandidateResult<TCandidate>> = [];
  let timedOutCount = 0;

  for (const slot of slots) {
    if (slot.status === "priced") {
      priced.push(slot);
    } else {
      dropped.push(slot);
      if (slot.timedOut) {
        timedOutCount += 1;
      }
    }
  }

  return {
    priced,
    dropped,
    deadlineMs,
    perAnchorTimeoutMs,
    timedOutCount,
  };
}
