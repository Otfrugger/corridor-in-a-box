import { describe, expect, it, vi } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter, type Quote } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import { InMemoryIdempotencyStore, createMockSubmitter, execute } from "@corridor/engine";
import { ok, type PaymentIntent } from "@corridor/types";

// The contract `examples/verify-quote-expiry.ts` asserts on live testnet, pinned
// here so a refactor that starts complying/opening before the quote freshness
// check fails in `pnpm test` instead of only in the scheduled live run.
//
// The live script cannot run in the default suite (it needs the reference anchor
// and a funded testnet signer), but the behaviour it checks is ordinary engine
// behaviour: a firm quote whose `expiresAt` has passed must be refused at the
// quote step, with no comply, no open and no settlement.

function corridor(): Corridor {
  const r = parseCorridor({
    id: "expiry-lane",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        quote_server: "https://d.example/sep38",
      },
    },
    fx: {
      path: ["ARS", "USDC", "ARS"],
      quote_source: "sep38",
      who_holds_risk: "receiving_anchor",
      quote_ttl_seconds: 60,
    },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "testnet", asset_issuer: "GISSUER" },
    recovery: { max_retries: 3, rollback: "refund_sender" },
  });
  if (!r.ok) throw new Error(`fixture invalid: ${r.error.message}`);
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "expired-quote-1",
  corridorId: "expiry-lane",
  sender: { id: "sender-1" },
  recipient: { id: "recip-1" },
  sourceAmount: { asset: "USDC", amount: "10.00" },
};

/** A quote the anchor really did issue, read back after its expiry passed. */
function expiredQuote(): Quote {
  return {
    id: "q-live-expired",
    price: "1",
    expiresAt: Date.now() - 1_000,
    sourceAmount: { asset: "USDC", amount: "10.00" },
    destAmount: { asset: "iso4217:ARS", amount: "10.00" },
    firm: true,
  };
}

describe("a firm quote that expired before the payment", () => {
  it("is refused at the quote step: no comply, no open, no submit, state failed", async () => {
    const adapter = createMockAdapter();
    const ensureCompliance = vi.spyOn(adapter, "ensureCompliance");
    const openTransaction = vi.spyOn(adapter, "openTransaction");
    const submitter = createMockSubmitter();
    const submit = vi.spyOn(submitter, "submit");
    const store = new InMemoryIdempotencyStore();

    const result = await execute(intent, corridor(), {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
      quoteProvider: { source: "sep38", quote: async () => ok(expiredQuote()) },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("QUOTE_EXPIRED");
      expect(result.error.message).toContain("expired before use");
    }
    expect(ensureCompliance).not.toHaveBeenCalled();
    expect(openTransaction).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    const stored = await store.get(intent.idempotencyKey);
    expect(stored?.state).toBe("failed");
    expect(stored?.stellarTxHash).toBeUndefined();
    expect(stored?.transactionId).toBeUndefined();
  });

  it("never reaches the pre-settle gate, so no balance check can pass by accident", async () => {
    const gate = { evaluate: vi.fn() };
    const result = await execute(intent, corridor(), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      gate,
      quoteProvider: { source: "sep38", quote: async () => ok(expiredQuote()) },
    });

    expect(result.ok).toBe(false);
    expect(gate.evaluate).not.toHaveBeenCalled();
  });
});
