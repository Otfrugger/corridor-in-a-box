// Route planner interface and types (RFC 0004 §1).
//
// A RoutePlanner evaluates candidate corridors for a payment request and returns
// ranked route options, each carrying an honest PriceLabel and audit reasons.

import type { Money } from "@corridor/types";

/**
 * Input to `RoutePlanner.plan()` describing the payment to route and price (RFC 0004 §1).
 */
export interface RouteRequest {
  /** Source amount and asset supplied by the sender (for example, 100 USDC). */
  readonly sourceAmount: Money;
  /** Destination payout asset identifier (for example, `"iso4217:NGN"`). */
  readonly destAsset: string;
  /** Destination country as an ISO 3166-1 alpha-2 code (for example, `"NG"`). */
  readonly destCountry: string;
  /** Optional payout rail or method (for example, `"bank_account"` or `"mobile_money"`). */
  readonly payoutMethod?: string;
  /** Optional policy overrides governing allowed price labels and estimate parameters. */
  readonly policy?: RoutePolicy;
}

/**
 * Per-request policy settings for price-label filtering and historical rate estimates (RFC 0004 §1).
 */
export interface RoutePolicy {
  /** Allowed price labels to offer (for example, `["locked"]` for locked-only). */
  readonly allowedLabels?: ReadonlyArray<PriceLabel>;
  /** Whether the sending business guarantees estimated prices from its own funds (RFC 0004 D4; default `false`). */
  readonly guaranteeEstimates?: boolean;
  /** Number of trailing days of rate history used for `estimated` prices (RFC 0004 D3; default `7`). */
  readonly estimateWindowDays?: number;
  /** Safety margin in basis points subtracted from non-locked prices (RFC 0004 D3; default `50`). */
  readonly estimateMarginBps?: number;
}

/**
 * Firmness disclosure label attached to every route option's price (RFC 0004 D2):
 * - `"locked"`: backed by a firm SEP-38 quote.
 * - `"indicative"`: the anchor's current published price, not promised.
 * - `"estimated"`: derived from historical rate observations (P25 minus margin).
 */
export type PriceLabel = "locked" | "indicative" | "estimated";

/**
 * A ranked route candidate returned by `RoutePlanner.plan()` (RFC 0004 §1).
 */
export interface RouteOption {
  /** Identifier of the corridor manifest backing this route option. */
  readonly corridorId: string;
  /** Receiving anchor's canonical home domain. */
  readonly receivingDomain: string;
  /** Payout protocol spoken by the route (`"sep31"`, `"sep6"`, or `"wallet"`). */
  readonly protocol: "sep31" | "sep6" | "wallet";
  /** Price firmness label, rate, and provenance metadata for this route option. */
  readonly price: {
    /** Firmness disclosure label for the quoted or estimated rate. */
    readonly label: PriceLabel;
    /** Destination units per 1 source unit, as a decimal string. */
    readonly rate: string;
    /** Firm quote identifier when `label === "locked"`. */
    readonly quoteId?: string;
    /** Epoch milliseconds at which a locked quote expires (`label === "locked"` only). */
    readonly expiresAt?: number;
    /** Provenance summary for estimated prices (for example, `"P25 of 1,912 samples, 7d"`). */
    readonly basis?: string;
  };
  /** Net destination amount the recipient receives after fees at the labelled rate. */
  readonly recipientGets: Money;
  /** Total fees deducted for this route option. */
  readonly fees: Money;
  /** Historical success rate in `0..1`, scaled by attestation freshness (RFC 0004 §1 "Ranking"). */
  readonly reliability: number;
  /** Ordered explanation of why this option ranked here (or was dropped), for display and audit. */
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Evaluates candidate routes for a `RouteRequest` and returns ranked `RouteOption`s (RFC 0004 §1).
 */
export interface RoutePlanner {
  /** Plan and rank route options for `req`. */
  plan(req: RouteRequest): Promise<ReadonlyArray<RouteOption>>;
}
