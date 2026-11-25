import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PARALLEL_DEADLINE_MS,
  formatNoPriceWithinReason,
  priceCandidatesInParallel,
} from "@corridor/router";

describe("priceCandidatesInParallel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T09:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prices candidates concurrently and returns all arriving before the default 5 s deadline", async () => {
    const candidates = [
      { receivingDomain: "fast.example", protocol: "sep31" },
      { receivingDomain: "slow.example", protocol: "sep31" },
      { receivingDomain: "medium.example", protocol: "sep6" },
    ];

    const started: string[] = [];
    const pending = priceCandidatesInParallel(candidates, async (candidate) => {
      started.push(candidate.receivingDomain);
      const delayMs =
        candidate.receivingDomain === "fast.example"
          ? 200
          : candidate.receivingDomain === "medium.example"
            ? 1_200
            : 8_000;
      return new Promise<{ rate: string }>((resolve) => {
        setTimeout(() => resolve({ rate: "1.05" }), delayMs);
      });
    });

    expect(started).toEqual(["fast.example", "slow.example", "medium.example"]);

    await vi.advanceTimersByTimeAsync(1_200);
    const resultBeforeDeadline = await Promise.race([
      pending.then(() => "settled"),
      Promise.resolve("pending"),
    ]);
    expect(resultBeforeDeadline).toBe("pending");

    await vi.advanceTimersByTimeAsync(DEFAULT_PARALLEL_DEADLINE_MS - 1_200);
    const result = await pending;

    expect(result.deadlineMs).toBe(5_000);
    expect(result.priced.map((entry) => entry.candidate.receivingDomain)).toEqual([
      "fast.example",
      "medium.example",
    ]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({
      candidate: { receivingDomain: "slow.example", protocol: "sep31" },
      status: "dropped",
      timedOut: true,
      reason: "no price within 5 s",
    });
    expect(result.timedOutCount).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects custom per-anchor timeouts, aborts late requests, and clears timers when all finish early", async () => {
    const abortedDomains: string[] = [];
    const candidates = [
      { receivingDomain: "anchor-a.example", protocol: "sep31" },
      { receivingDomain: "anchor-b.example", protocol: "sep31" },
      { receivingDomain: "anchor-c.example", protocol: "sep31" },
    ];

    const pending = priceCandidatesInParallel(
      candidates,
      (candidate, ctx) =>
        new Promise<string>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            abortedDomains.push(candidate.receivingDomain);
            reject(ctx.signal.reason ?? new Error("aborted"));
          });
          if (candidate.receivingDomain === "anchor-a.example") {
            setTimeout(() => resolve("quote-a"), 400);
          } else if (candidate.receivingDomain === "anchor-b.example") {
            setTimeout(() => reject(new Error("upstream 503")), 600);
          }
        }),
      { deadlineMs: 4_000, perAnchorTimeoutMs: 2_000 },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.priced).toHaveLength(1);
    expect(result.priced[0]?.option).toBe("quote-a");
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0]).toMatchObject({
      candidate: { receivingDomain: "anchor-b.example" },
      timedOut: false,
      reason: "upstream 503",
    });
    expect(result.dropped[1]).toMatchObject({
      candidate: { receivingDomain: "anchor-c.example" },
      timedOut: true,
      reason: "no price within 2 s",
    });
    expect(abortedDomains).toEqual(["anchor-c.example"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears deadline timer immediately when all candidates finish before the deadline", async () => {
    const pending = priceCandidatesInParallel(
      [{ receivingDomain: "instant.example" }],
      async () => "ok",
    );

    const result = await pending;
    expect(result.priced).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles empty candidate lists and formats sub-second or whole-second reasons cleanly", async () => {
    const empty = await priceCandidatesInParallel([], async () => "unused");
    expect(empty.priced).toEqual([]);
    expect(empty.dropped).toEqual([]);
    expect(empty.timedOutCount).toBe(0);

    expect(formatNoPriceWithinReason(5_000)).toBe("no price within 5 s");
    expect(formatNoPriceWithinReason(1_500)).toBe("no price within 1.5 s");
    expect(formatNoPriceWithinReason(250)).toBe("no price within 250 ms");
  });
});
