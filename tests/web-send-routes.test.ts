import { describe, expect, it } from "vitest";
import type { RouteOption } from "@corridor/router";
import {
  PRICE_LABELS,
  PRICE_LABEL_MEANING,
  describePrice,
  formatAmount,
  formatMoney,
  plainReason,
  routeKey,
} from "../web/lib/send";

// #686: the ranked route options with their labels and reasons.

const NOW = 1_800_000_000_000;

function option(
  label: RouteOption["price"]["label"],
  extra: Partial<RouteOption["price"]> = {},
): RouteOption {
  return {
    corridorId: "reference-testnet",
    receivingDomain: "anchor.test",
    protocol: "sep31",
    price: { label, rate: "1520.5", ...extra },
    recipientGets: { asset: "iso4217:NGN", amount: "152050.00" },
    fees: { asset: "USDC", amount: "0.50" },
    reliability: 0.97,
    reasons: [],
  };
}

describe("price labels (#686, RFC 0004 §2)", () => {
  it("has exactly the three labels, each with its own meaning", () => {
    expect(PRICE_LABELS).toEqual(["locked", "indicative", "estimated"]);
    const meanings = PRICE_LABELS.map((l) => PRICE_LABEL_MEANING[l]);
    expect(new Set(meanings).size).toBe(3);
  });

  it("words each label as RFC 0004 §2 shows it to the sender", () => {
    expect(describePrice(option("locked", { expiresAt: NOW + 60_000 }), NOW)).toBe(
      "Recipient gets 152,050.00 NGN. Locked for 60 s.",
    );
    expect(describePrice(option("indicative"), NOW)).toBe(
      "About 152,050.00 NGN. Final amount set at payout.",
    );
    expect(describePrice(option("estimated"), NOW)).toBe("About 152,050.00 NGN (estimated)");
    expect(describePrice(option("estimated"), NOW, { guaranteeEstimates: true })).toBe(
      "At least 152,050.00 NGN (estimated)",
    );
  });

  it("never merges labels: the same amount reads differently under each label", () => {
    const lines = [
      describePrice(option("locked", { expiresAt: NOW + 60_000 }), NOW),
      describePrice(option("indicative"), NOW),
      describePrice(option("estimated"), NOW),
    ];
    expect(new Set(lines).size).toBe(3);
    // An estimate always says so; an indicative price never claims to be locked.
    expect(lines[2]).toContain("(estimated)");
    expect(lines[1]).not.toMatch(/locked/i);
  });

  it("says when a locked price has run out instead of showing zero seconds", () => {
    expect(describePrice(option("locked", { expiresAt: NOW - 1 }), NOW)).toBe(
      "Recipient gets 152,050.00 NGN. This locked price has expired.",
    );
  });

  it("gives options that differ only in label distinct keys", () => {
    const keys = PRICE_LABELS.map((l) => routeKey(option(l)));
    expect(new Set(keys).size).toBe(3);
  });
});

describe("reasons in plain words (#686)", () => {
  it("rewords the router's documented reason formats", () => {
    expect(plainReason("locked for 60 s")).toBe("The anchor holds this price for 60 seconds.");
    expect(plainReason("indicative rate")).toBe("Today's price from the receiving anchor.");
    expect(plainReason("estimated from 1,912 samples over 7 d")).toBe(
      "Worked out from 1,912 rates seen over the last 7 days.",
    );
    expect(plainReason("dropped: amount above max 10,000 USDC")).toBe(
      "The amount is above this anchor's limit of 10,000 USDC.",
    );
    expect(plainReason("dropped: no price within 5 s")).toBe(
      "This anchor did not answer with a price within 5 seconds.",
    );
    expect(plainReason("dropped: circuit breaker open (retry in 30 s)")).toBe(
      "This anchor failed several recent payments, so it is paused.",
    );
  });

  it("shows an unknown reason as a sentence rather than hiding it", () => {
    expect(plainReason("attested 2h ago")).toBe("Attested 2h ago.");
    expect(plainReason("dropped: anchor said no")).toBe("Anchor said no.");
    expect(plainReason("Fastest payout.")).toBe("Fastest payout.");
  });
});

describe("amounts are formatted from strings, never floats", () => {
  it("groups thousands and keeps every decimal", () => {
    expect(formatAmount("1234567.1234567")).toBe("1,234,567.1234567");
    expect(formatAmount("0.1")).toBe("0.1");
    expect(formatMoney({ asset: "iso4217:NGN", amount: "1000" })).toBe("1,000 NGN");
    expect(
      formatMoney({
        asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "5",
      }),
    ).toBe("5 USDC");
  });
});
