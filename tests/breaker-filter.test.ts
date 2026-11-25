import { describe, expect, it } from "vitest";
import { InMemoryCorridorHealthStore } from "@corridor/engine";
import { filterByCircuitBreaker, type BreakerFilterCandidate } from "@corridor/router";

describe("router circuit breaker filter (#607)", () => {
  it("drops candidates with open breakers carrying 'circuit breaker open since <time>'", async () => {
    const store = new InMemoryCorridorHealthStore();
    const trippedAt = Date.UTC(2026, 10, 19, 14, 30, 0);

    await store.recordOutcome("halted-lane", "failure", trippedAt, {
      threshold: 1,
      error: "RECONCILE_STALLED",
    });

    const candidates: BreakerFilterCandidate[] = [
      { domain: "healthy.example", corridorId: "healthy-lane", protocol: "sep31" },
      { domain: "halted.example", corridorId: "halted-lane", protocol: "sep31" },
    ];

    const res = await filterByCircuitBreaker(candidates, store);

    expect(res.offered).toEqual([candidates[0]]);
    expect(res.dropped).toEqual([
      {
        domain: "halted.example",
        receivingDomain: "halted.example",
        corridorId: "halted-lane",
        protocol: "sep31",
        dropped: true,
        reason: "circuit breaker open since 2026-11-19T14:30:00.000Z",
      },
    ]);
  });

  it("keeps lanes whose breaker was reset back to closed", async () => {
    const store = new InMemoryCorridorHealthStore();
    await store.recordOutcome("recovered.example", "failure", 1_700_000_000_000, {
      threshold: 1,
    });
    await store.reset("recovered.example", "ops", "anchor back online", 1_700_000_100_000);

    const res = await filterByCircuitBreaker([{ domain: "recovered.example" }], store);
    expect(res.offered).toHaveLength(1);
    expect(res.dropped).toEqual([]);
  });
});
