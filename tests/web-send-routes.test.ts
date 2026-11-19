import { describe, expect, it } from "vitest";
import { PRICE_LABELS, findRouteOptions, type PriceLabel } from "../web/lib/send";

describe("Route options list with RFC 0004 §2 labels and reasons (Issue #686)", () => {
  it("defines exact RFC 0004 §2 wording for locked, indicative, and estimated", () => {
    expect(PRICE_LABELS.locked.title).toBe("Locked Price");
    expect(PRICE_LABELS.locked.description).toBe(
      "A locked price comes from a firm SEP-38 quote. The rate is guaranteed until it expires.",
    );

    expect(PRICE_LABELS.indicative.title).toBe("Indicative Price");
    expect(PRICE_LABELS.indicative.description).toBe(
      "An indicative price comes from current market rates or SEP-38 /price. The final rate may differ when the payment executes.",
    );

    expect(PRICE_LABELS.estimated.title).toBe("Estimated Price");
    expect(PRICE_LABELS.estimated.description).toBe(
      "An estimated price is calculated from historical rate data. It is a benchmark estimate, not a live quote.",
    );
  });

  it("never merges or hides labels across route options", () => {
    const options = findRouteOptions({
      amount: "100.00",
      sourceAsset: "USDC",
      destCountry: "NG",
      destCurrency: "NGN",
    });

    expect(options.length).toBeGreaterThan(0);

    const validLabels: PriceLabel[] = ["locked", "indicative", "estimated"];
    const observedLabels = new Set<PriceLabel>();

    for (const option of options) {
      expect(validLabels).toContain(option.label);
      observedLabels.add(option.label);

      // Verify label is not empty or generic
      expect(option.label.length).toBeGreaterThan(0);
      expect(PRICE_LABELS[option.label]).toBeDefined();
    }

    // Must exhibit multiple distinct labels (e.g. locked, indicative, estimated)
    expect(observedLabels.size).toBeGreaterThanOrEqual(2);
  });

  it("includes human-readable reasons on every option", () => {
    const options = findRouteOptions({
      amount: "250.00",
      sourceAsset: "USDC",
      destCountry: "MX",
      destCurrency: "MXN",
    });

    for (const option of options) {
      expect(option.reasons).toBeDefined();
      expect(Array.isArray(option.reasons)).toBe(true);
      expect(option.reasons.length).toBeGreaterThan(0);

      // Every reason should be a clear, non-empty descriptive string
      for (const reason of option.reasons) {
        expect(typeof reason).toBe("string");
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("ranks options with highest payout first", () => {
    const options = findRouteOptions({
      amount: "100.00",
      sourceAsset: "USDC",
      destCountry: "NG",
      destCurrency: "NGN",
    });

    const payouts = options.map((o) => Number(o.destAmount));
    for (let i = 1; i < payouts.length; i++) {
      expect(payouts[i - 1]).toBeGreaterThanOrEqual(payouts[i]);
    }
  });
});
