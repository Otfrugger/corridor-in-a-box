import { describe, expect, it } from "vitest";
import type { RouteOption } from "@corridor/router";
import {
  QUOTE_WARNING_SECONDS,
  formatCountdown,
  isQuoteExpired,
  quoteSecondsLeft,
  sendBlockedBy,
} from "../web/lib/send";

// #687: the countdown on a locked price, and Send refusing an expired one.

const NOW = 1_800_000_000_000;

function option(price: RouteOption["price"]): RouteOption {
  return {
    corridorId: "reference-testnet",
    receivingDomain: "anchor.test",
    protocol: "sep31",
    price,
    recipientGets: { asset: "iso4217:USD", amount: "99.50" },
    fees: { asset: "USDC", amount: "0.50" },
    reliability: 1,
    reasons: [],
  };
}

const locked = (expiresAt?: number) =>
  option({
    label: "locked",
    rate: "1",
    quoteId: "q-1",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });

describe("locked price countdown (#687)", () => {
  it("counts whole seconds down to zero", () => {
    expect(quoteSecondsLeft(locked(NOW + 60_000), NOW)).toBe(60);
    expect(quoteSecondsLeft(locked(NOW + 59_999), NOW)).toBe(59);
    expect(quoteSecondsLeft(locked(NOW - 5_000), NOW)).toBe(0);
  });

  it("has no countdown for prices that are not locked", () => {
    expect(quoteSecondsLeft(option({ label: "indicative", rate: "1" }), NOW)).toBeUndefined();
    expect(quoteSecondsLeft(option({ label: "estimated", rate: "1" }), NOW)).toBeUndefined();
    expect(isQuoteExpired(option({ label: "indicative", rate: "1" }), NOW)).toBe(false);
  });

  it("expires at the expiry instant, not a second later", () => {
    expect(isQuoteExpired(locked(NOW + 1), NOW)).toBe(false);
    expect(isQuoteExpired(locked(NOW), NOW)).toBe(true);
  });

  it("treats a locked price with no expiry as expired, since nothing says it is still held", () => {
    expect(isQuoteExpired(locked(), NOW)).toBe(true);
  });

  it("formats the countdown as m:ss", () => {
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(QUOTE_WARNING_SECONDS).toBeGreaterThan(0);
  });
});

describe("expired quotes can't be sent (#687)", () => {
  const base = { fields: [], values: {} };

  it("blocks Send once the locked price has expired", () => {
    expect(sendBlockedBy({ ...base, option: locked(NOW + 30_000), nowMs: NOW })).toBeNull();
    expect(sendBlockedBy({ ...base, option: locked(NOW + 30_000), nowMs: NOW + 30_000 })).toBe(
      "quote_expired",
    );
  });

  it("blocks Send with no route selected", () => {
    expect(sendBlockedBy({ ...base, option: null, nowMs: NOW })).toBe("no_route");
  });

  it("never blocks an indicative or estimated price on time", () => {
    const indicative = option({ label: "indicative", rate: "1" });
    expect(sendBlockedBy({ ...base, option: indicative, nowMs: NOW + 10 ** 9 })).toBeNull();
  });
});
