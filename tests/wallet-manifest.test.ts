import { describe, expect, it } from "vitest";
import {
  WalletDestinationSchema,
  complianceMethod,
  hashCorridor,
  liveness,
  parseCorridor,
  parseCorridorYaml,
  protocolOf,
} from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

const WALLET_YAML = `
id: usdc-stellar-wallet
source:
  name: Treasury
  asset: USDC
dest:
  name: Recipient Stellar Wallet
  protocol: wallet
  asset: USDC
  asset_issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  endpoints:
    home_domain: wallet.example
fx:
  path: [USDC, USDC]
  quote_source: native
  who_holds_risk: sender
compliance:
  source_jurisdiction: US
  dest_jurisdiction: KE
settlement:
  bridge_asset: USDC
  network: testnet
  asset_issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
recovery:
  reconcile:
    external_stall_seconds: 300
`;

describe("wallet route manifest (#646)", () => {
  it("parses a wallet corridor manifest with asset and network declared and no endpoints", () => {
    const res = parseCorridorYaml(WALLET_YAML);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(protocolOf(res.value.dest)).toBe("wallet");
    expect(res.value.dest.asset).toBe("USDC");
    expect(res.value.settlement.network).toBe("testnet");
    expect(res.value.dest.endpoints.home_domain).toBe("wallet.example");
    expect(complianceMethod(res.value)).toBe("none");
    expect(res.warnings).toEqual([]);
  });

  it("produces deterministic manifest hashes and never reports a wallet lane as runnable", () => {
    const a = parseCorridorYaml(WALLET_YAML);
    const b = parseCorridorYaml(WALLET_YAML);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(hashCorridor(a.value)).toBe(hashCorridor(b.value));
    // The engine cannot execute a wallet lane yet (RFC 0004 D5), so it must not show as runnable.
    const live = liveness(a.value);
    expect(live.runnable).toBe(false);
    expect(live.state).toBe("not-runnable");
  });

  it("rejects wallet manifests missing asset or settlement network or setting incompatible compliance", () => {
    const base = parseCorridorYaml(WALLET_YAML);
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const noAsset = structuredClone(base.value) as unknown as Record<string, unknown>;
    (noAsset.dest as Record<string, unknown>).asset = "";
    expect(parseCorridor(noAsset).ok).toBe(false);

    const badNetwork = structuredClone(base.value) as unknown as Record<string, unknown>;
    (badNetwork.settlement as Record<string, unknown>).network = "futurenet";
    expect(parseCorridor(badNetwork).ok).toBe(false);

    const badCompliance = structuredClone(base.value) as unknown as Record<string, unknown>;
    (badCompliance.compliance as Record<string, unknown>).method = "sep12";
    expect(parseCorridor(badCompliance).ok).toBe(false);
  });

  it("validates intent-supplied recipient Stellar account and optional memo", () => {
    const intent: PaymentIntent = {
      idempotencyKey: "wallet-1",
      corridorId: "usdc-stellar-wallet",
      sender: { id: "s1" },
      recipient: { id: "r1" },
      sourceAmount: { asset: "USDC", amount: "25.00" },
      wallet: {
        account: "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF",
        memo: "invoice-42",
        memoType: "text",
      },
    };
    expect(WalletDestinationSchema.safeParse(intent.wallet).success).toBe(true);
    expect(
      WalletDestinationSchema.safeParse({
        account: "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF",
      }).success,
    ).toBe(true);

    expect(WalletDestinationSchema.safeParse({ account: "not-a-key" }).success).toBe(false);
    expect(
      WalletDestinationSchema.safeParse({
        account: "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF",
        memo: "x".repeat(29),
        memoType: "text",
      }).success,
    ).toBe(false);
    expect(
      WalletDestinationSchema.safeParse({
        account: "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF",
        memo: "abc",
        memoType: "id",
      }).success,
    ).toBe(false);
  });
});
