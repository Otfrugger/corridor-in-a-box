// Locked price builder via AnchorAdapter firm quotes (#608).
//
// Calls `adapter.requestQuote(intent, corridor)` — and never opens a
// transaction — returning a `"locked"` route option with `quoteId` and
// `expiresAt` when `Quote.firm` is true and unexpired.

import type { AnchorAdapter, Quote } from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

export interface FirmQuoteCandidate {
  readonly domain: string;
  readonly corridor: Corridor;
  readonly adapter: AnchorAdapter;
}

export interface LockedRouteOption {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol: string;
  readonly label: "locked";
  readonly price: {
    readonly label: "locked";
    readonly rate: string;
    readonly destAmount: string;
    readonly cautiousDestAmount: string;
    readonly quoteId: string;
    readonly expiresAt: number;
  };
  readonly destAmount: string;
  readonly cautiousDestAmount: string;
  readonly quoteId: string;
  readonly expiresAt: number;
  readonly quote: Quote;
  readonly reason: string;
}

export interface FirmQuoteDroppedOption {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol: string;
  readonly dropped: true;
  readonly reason: string;
}

export type FirmQuoteResult =
  | { readonly ok: true; readonly option: LockedRouteOption }
  | { readonly ok: false; readonly dropped: FirmQuoteDroppedOption };

export interface RequestLockedOptionOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function drop(candidate: FirmQuoteCandidate, reason: string): FirmQuoteResult {
  return {
    ok: false,
    dropped: {
      domain: candidate.domain,
      receivingDomain: candidate.domain,
      protocol: candidate.corridor.dest.protocol,
      dropped: true,
      reason,
    },
  };
}

/**
 * Request a firm SEP-38 quote from `candidate.adapter` (without calling
 * `openTransaction`) and turn it into a `"locked"` route option.
 */
export async function requestLockedOption(
  candidate: FirmQuoteCandidate,
  intent: PaymentIntent,
  opts: RequestLockedOptionOptions = {},
): Promise<FirmQuoteResult> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const quoteOutcome =
      timeoutMs !== undefined && timeoutMs > 0
        ? await Promise.race([
            candidate.adapter.requestQuote(intent, candidate.corridor),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`quote timeout after ${timeoutMs}ms`)),
                timeoutMs,
              );
            }),
          ])
        : await candidate.adapter.requestQuote(intent, candidate.corridor);

    if (!quoteOutcome.ok) {
      return drop(candidate, `quote refused: ${quoteOutcome.error.message}`);
    }

    const q = quoteOutcome.value;
    if (!q.firm) {
      return drop(candidate, "anchor returned non-firm quote");
    }

    const currentMs = now();
    if (q.expiresAt <= currentMs) {
      return drop(candidate, `firm quote ${q.id} already expired`);
    }

    const remainingSecs = Math.max(1, Math.floor((q.expiresAt - currentMs) / 1000));
    return {
      ok: true,
      option: {
        domain: candidate.domain,
        receivingDomain: candidate.domain,
        protocol: candidate.corridor.dest.protocol,
        label: "locked",
        price: {
          label: "locked",
          rate: q.price,
          destAmount: q.destAmount.amount,
          cautiousDestAmount: q.destAmount.amount,
          quoteId: q.id,
          expiresAt: q.expiresAt,
        },
        destAmount: q.destAmount.amount,
        cautiousDestAmount: q.destAmount.amount,
        quoteId: q.id,
        expiresAt: q.expiresAt,
        quote: q,
        reason: `locked for ${remainingSecs} s`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return drop(candidate, msg.includes("timeout") ? msg : `quote failed: ${msg}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
