import { describe, expect, it, vi } from "vitest";
import { createMockAdapter, type AnchorAdapter } from "@corridor/adapter-kit";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { fail, ok, type PaymentIntent } from "@corridor/types";
import { requestLockedOption } from "@corridor/router";

function fixtureCorridor(domain = "quoted.example"): Corridor {
  const r = parseCorridor({
    id: "locked-quote-test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      protocol: "sep31",
      endpoints: {
        home_domain: domain,
        transfer_server_sep31: `https://${domain}/sep31`,
        quote_server: `https://${domain}/sep38`,
      },
    },
    fx: { path: ["USD", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "AR" },
    settlement: { network: "testnet", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error(`fixture invalid: ${r.error.message}`);
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "k-quote-1",
  corridorId: "locked-quote-test",
  sender: { id: "s1" },
  recipient: { id: "r1" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

describe("router locked price from SEP-38 firm quote (#608)", () => {
  it("returns a locked option with quoteId and expiresAt from mock adapter without opening a tx", async () => {
    const base = createMockAdapter({ name: "quoted.example", price: "1020" });
    let openCalled = false;
    const adapter: AnchorAdapter = {
      ...base,
      async openTransaction(i, q, c) {
        openCalled = true;
        return base.openTransaction(i, q, c);
      },
    };

    const corridor = fixtureCorridor();
    const res = await requestLockedOption(
      { domain: "quoted.example", corridor, adapter },
      intent,
    );

    expect(openCalled).toBe(false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.option.label).toBe("locked");
    expect(res.option.quoteId).toMatch(/^q_/);
    expect(res.option.expiresAt).toBeGreaterThan(Date.now() - 1000);
    expect(res.option.price.label).toBe("locked");
    expect(res.option.reason).toMatch(/^locked for \d+ s$/);
  });

  it("drops the candidate when the anchor refuses the quote", async () => {
    const base = createMockAdapter();
    const adapter: AnchorAdapter = {
      ...base,
      async requestQuote() {
        return fail("QUOTE_UNAVAILABLE", "pair suspended", { retryable: false });
      },
    };

    const res = await requestLockedOption(
      { domain: "refused.example", corridor: fixtureCorridor("refused.example"), adapter },
      intent,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.dropped.dropped).toBe(true);
    expect(res.dropped.reason).toContain("quote refused: pair suspended");
  });

  it("drops the candidate when requestQuote exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const base = createMockAdapter();
      const adapter: AnchorAdapter = {
        ...base,
        async requestQuote() {
          return new Promise(() => {
            // Never resolves within timeout window.
          });
        },
      };

      const promise = requestLockedOption(
        { domain: "slow.example", corridor: fixtureCorridor("slow.example"), adapter },
        intent,
        { timeoutMs: 2_000 },
      );

      await vi.advanceTimersByTimeAsync(2_001);
      const res = await promise;
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.dropped.reason).toContain("quote timeout after 2000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops non-firm quotes instead of falsely labelling them locked", async () => {
    const base = createMockAdapter();
    const adapter: AnchorAdapter = {
      ...base,
      async requestQuote(i, c) {
        const q = await base.requestQuote(i, c);
        if (!q.ok) return q;
        return ok({ ...q.value, firm: false });
      },
    };

    const res = await requestLockedOption(
      { domain: "soft.example", corridor: fixtureCorridor("soft.example"), adapter },
      intent,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.dropped.reason).toContain("non-firm");
    }
  });
});
