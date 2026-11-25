import { describe, expect, it } from "vitest";
import {
  MAX_STELLAR_AMOUNT,
  sendOptionsFromCorridors,
  toRouteRequest,
  validateSendAmount,
} from "../web/lib/send";
import generated from "../web/lib/generated/corridors.json";

// #685: the amount and destination form. Root suite, like the other web/lib tests.

function errorOf(input: string, limits?: { min?: string; max?: string }): string {
  const result = validateSendAmount(input, limits);
  if (result.valid) throw new Error(`expected "${input}" to be rejected`);
  return result.error;
}

describe("validateSendAmount (#685)", () => {
  it("accepts positive decimal amounts and returns them trimmed, as strings", () => {
    expect(validateSendAmount("100")).toEqual({ valid: true, amount: "100" });
    expect(validateSendAmount(" 25.50 ")).toEqual({ valid: true, amount: "25.50" });
    expect(validateSendAmount("0.0000001")).toEqual({ valid: true, amount: "0.0000001" });
    expect(validateSendAmount(MAX_STELLAR_AMOUNT)).toEqual({
      valid: true,
      amount: MAX_STELLAR_AMOUNT,
    });
  });

  it("rejects an empty amount with a clear message", () => {
    expect(errorOf("")).toBe("Enter an amount to send.");
    expect(errorOf("   ")).toBe("Enter an amount to send.");
  });

  it("rejects zero and negative amounts", () => {
    expect(errorOf("0")).toBe("The amount must be more than zero.");
    expect(errorOf("0.0000000")).toBe("The amount must be more than zero.");
    expect(errorOf("-5")).toBe("The amount must be more than zero.");
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of [
      "abc",
      "1e3",
      "1,000",
      "12.",
      ".5",
      "Infinity",
      "NaN",
      "0x10",
      "1 000",
    ]) {
      expect(errorOf(bad), bad).toMatch(/digits only/);
    }
  });

  it("rejects more decimal places than Stellar holds", () => {
    expect(errorOf("1.00000001")).toBe("Use at most 7 digits after the decimal point.");
  });

  it("rejects amounts above what a Stellar operation can carry, without rounding through a float", () => {
    expect(errorOf("922337203685.4775808")).toBe(
      "That amount is too large to send on Stellar.",
    );
    expect(errorOf("99999999999999999999")).toBe(
      "That amount is too large to send on Stellar.",
    );
  });

  it("applies the anchor's min and max when given, compared as decimals", () => {
    expect(errorOf("0.5", { min: "1" })).toBe("The smallest amount you can send is 1.");
    expect(errorOf("10000.0000001", { max: "10000" })).toBe(
      "The largest amount you can send is 10000.",
    );
    expect(validateSendAmount("10000", { min: "1", max: "10000" }).valid).toBe(true);
  });
});

describe("destinations come from the corridor manifests (#685)", () => {
  it("offers only testnet lanes, deduplicated, with ISO currency codes", () => {
    const { destinations, sourceAssets } = sendOptionsFromCorridors([
      {
        source: { asset: "USDC" },
        dest: { asset: "iso4217:USD" },
        compliance: { dest_jurisdiction: "US" },
        settlement: { network: "testnet" },
      },
      {
        source: { asset: "USDC" },
        dest: { asset: "iso4217:USD" },
        compliance: { dest_jurisdiction: "us" },
        settlement: { network: "testnet" },
      },
      {
        source: { asset: "EURC" },
        dest: { asset: "iso4217:NGN" },
        compliance: { dest_jurisdiction: "NG" },
        settlement: { network: "public" },
      },
    ]);
    expect(destinations).toEqual([{ country: "US", currency: "USD" }]);
    expect(sourceAssets).toEqual(["USDC"]);
  });

  it("finds at least one destination in the committed corridor data", () => {
    const { destinations } = sendOptionsFromCorridors(generated);
    expect(destinations.length).toBeGreaterThan(0);
  });

  it("builds the router's RouteRequest from the form", () => {
    expect(
      toRouteRequest({
        amount: "25.50",
        sourceAsset: "USDC",
        destination: { country: "NG", currency: "NGN" },
      }),
    ).toEqual({
      sourceAmount: { asset: "USDC", amount: "25.50" },
      destAsset: "iso4217:NGN",
      destCountry: "NG",
    });
  });
});
