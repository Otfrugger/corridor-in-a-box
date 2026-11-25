import { describe, expect, it } from "vitest";
import type {
  PriceLabel,
  RouteOption,
  RoutePlanner,
  RoutePolicy,
  RouteRequest,
} from "@corridor/router";

describe("@corridor/router planner types (#603)", () => {
  it("exports PriceLabel, RoutePolicy, RouteRequest, RouteOption and RoutePlanner matching RFC 0004 §1", async () => {
    const labels: readonly PriceLabel[] = ["locked", "indicative", "estimated"];
    expect(labels).toHaveLength(3);

    const policy: RoutePolicy = {
      allowedLabels: ["locked", "indicative", "estimated"],
      guaranteeEstimates: false,
      estimateWindowDays: 7,
      estimateMarginBps: 50,
    };

    const request: RouteRequest = {
      sourceAmount: { asset: "USDC", amount: "100" },
      destAsset: "iso4217:NGN",
      destCountry: "NG",
      payoutMethod: "bank_account",
      policy,
    };

    const lockedOption: RouteOption = {
      corridorId: "usdc-ngn-sep31",
      receivingDomain: "anchor.example",
      protocol: "sep31",
      price: {
        label: "locked",
        rate: "1550",
        quoteId: "q-123",
        expiresAt: 1_900_000_060_000,
      },
      recipientGets: { asset: "NGN", amount: "154500" },
      fees: { asset: "NGN", amount: "500" },
      reliability: 0.99,
      reasons: ["locked for 60 s", "99% success over 30 d"],
    };

    const estimatedOption: RouteOption = {
      corridorId: "usdc-ngn-sep6",
      receivingDomain: "sep6.example",
      protocol: "sep6",
      price: {
        label: "estimated",
        rate: "1535",
        basis: "P25 of 1,912 samples, 7d",
      },
      recipientGets: { asset: "NGN", amount: "153000" },
      fees: { asset: "NGN", amount: "500" },
      reliability: 0.95,
      reasons: ["estimated from 1,912 samples over 7 d"],
    };

    const walletOption: RouteOption = {
      corridorId: "usdc-ngn-wallet",
      receivingDomain: "wallet.example",
      protocol: "wallet",
      price: {
        label: "indicative",
        rate: "1540",
      },
      recipientGets: { asset: "NGN", amount: "153800" },
      fees: { asset: "NGN", amount: "200" },
      reliability: 0.97,
      reasons: ["indicative rate"],
    };

    const planner: RoutePlanner = {
      async plan(req: RouteRequest): Promise<ReadonlyArray<RouteOption>> {
        expect(req.destCountry).toBe("NG");
        return [lockedOption, walletOption, estimatedOption];
      },
    };

    const result = await planner.plan(request);
    expect(result).toHaveLength(3);
    expect(result[0]?.price.label).toBe("locked");
    expect(result[0]?.corridorId).toBe("usdc-ngn-sep31");
    expect(result[1]?.protocol).toBe("wallet");
    expect(result[2]?.price.basis).toBe("P25 of 1,912 samples, 7d");
  });
});
