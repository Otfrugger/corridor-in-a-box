import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  computePercentile,
  detectDuplicateSettlements,
  detectOnChainDuplicates,
  fetchSignerTransactionsSince,
  formatMarkdownReport,
  MAX_CONCURRENCY,
  parseLoadTestInputs,
  type OnChainTransaction,
  type PaymentAttemptResult,
} from "../examples/load-test";

describe("Load test metrics & duplicate settlement detection (#681)", () => {
  const root = process.cwd();

  it("detects when all settlements have unique transaction hashes", () => {
    const results: PaymentAttemptResult[] = [
      {
        index: 1,
        idempotencyKey: "key-1",
        ok: true,
        state: "completed",
        latencyMs: 120,
        stellarTxHash: "a1b2c3d4e5f6",
      },
      {
        index: 2,
        idempotencyKey: "key-2",
        ok: true,
        state: "completed",
        latencyMs: 150,
        stellarTxHash: "b2c3d4e5f6a1",
      },
      {
        index: 3,
        idempotencyKey: "key-3",
        ok: true,
        state: "completed",
        latencyMs: 110,
        stellarTxHash: "c3d4e5f6a1b2",
      },
    ];

    const dupCheck = detectDuplicateSettlements(results);
    expect(dupCheck.hasDuplicates).toBe(false);
    expect(dupCheck.duplicateHashes).toEqual([]);
    expect(dupCheck.totalSettled).toBe(3);
    expect(dupCheck.uniqueSettled).toBe(3);
  });

  it("detects duplicate settlements when two attempts submit the same transaction hash", () => {
    const results: PaymentAttemptResult[] = [
      {
        index: 1,
        idempotencyKey: "key-1",
        ok: true,
        state: "completed",
        latencyMs: 120,
        stellarTxHash: "duplicate-hash-1234",
      },
      {
        index: 2,
        idempotencyKey: "key-2",
        ok: true,
        state: "completed",
        latencyMs: 150,
        stellarTxHash: "unique-hash-5678",
      },
      {
        index: 3,
        idempotencyKey: "key-3",
        ok: true,
        state: "completed",
        latencyMs: 110,
        stellarTxHash: "duplicate-hash-1234",
      },
    ];

    const dupCheck = detectDuplicateSettlements(results);
    expect(dupCheck.hasDuplicates).toBe(true);
    expect(dupCheck.duplicateHashes).toEqual(["duplicate-hash-1234"]);
    expect(dupCheck.totalSettled).toBe(3);
    expect(dupCheck.uniqueSettled).toBe(2);
  });

  it("correctly computes percentiles", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(computePercentile(values, 50)).toBe(50);
    expect(computePercentile(values, 90)).toBe(90);
    expect(computePercentile(values, 95)).toBe(100);
    expect(computePercentile(values, 100)).toBe(100);
  });

  it("computes comprehensive load test metrics for 100 payments", () => {
    const results: PaymentAttemptResult[] = Array.from({ length: 100 }, (_, i) => ({
      index: i + 1,
      idempotencyKey: `load-${i + 1}`,
      ok: i < 98,
      state: i < 98 ? "completed" : "failed",
      latencyMs: 100 + (i % 20) * 10,
      stellarTxHash: i < 98 ? `hash-${i + 1}` : undefined,
      error: i >= 98 ? "RECONCILE_STALLED: counterparty timeout" : undefined,
    }));

    const metrics = computeMetrics(results, 15000);
    expect(metrics.total).toBe(100);
    expect(metrics.successful).toBe(98);
    expect(metrics.failed).toBe(2);
    expect(metrics.duplicateSettlements).toBe(0);
    expect(metrics.successRatePercent).toBe(98);
    expect(metrics.latency.min).toBe(100);
    expect(metrics.latency.max).toBe(290);
    expect(metrics.errorCounts["RECONCILE_STALLED: counterparty timeout"]).toBe(2);
  });

  it("formats a GitHub Step Summary markdown table", () => {
    const results: PaymentAttemptResult[] = [
      {
        index: 1,
        idempotencyKey: "load-1",
        ok: true,
        state: "completed",
        latencyMs: 150,
        stellarTxHash: "7b8a9c0d1e2f3a4b5c6d7e8f",
      },
    ];
    const metrics = computeMetrics(results, 150);
    const report = formatMarkdownReport(metrics, {
      corridorId: "reference-testnet",
      concurrency: 1,
      amount: "0.10",
      anchorUrl: "http://localhost:8080",
    });

    expect(report).toContain("## 🚀 Corridor Load Test Summary");
    expect(report).toContain("### Execution Overview");
    expect(report).toContain("| Total Payments | 1 |");
    expect(report).toContain("| Duplicate Settlements | 0 |");
    expect(report).toContain("### Latency Statistics (ms)");
    expect(report).toContain("7b8a9c0d1e2f3a4b...");
  });

  it("verifies load-test workflow is manual (workflow_dispatch only, never scheduled)", () => {
    const workflowPath = resolve(root, ".github/workflows/load-test.yml");
    const content = readFileSync(workflowPath, "utf8");

    expect(content).toContain("workflow_dispatch:");
    expect(content).not.toMatch(/^\s*schedule:/m);
    expect(content).not.toMatch(/^\s*push:/m);
    expect(content).not.toMatch(/^\s*pull_request:/m);
  });

  it("verifies package.json exposes the load-test script", () => {
    const pkgPath = resolve(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    expect(pkg.scripts["load-test"]).toBe("tsx examples/load-test.ts");
  });
});

describe("load test inputs and on-chain duplicate check (#681)", () => {
  it("accepts the defaults and refuses out-of-range or malformed inputs", () => {
    expect(parseLoadTestInputs({})).toEqual({ ok: true, concurrency: 100, amount: "0.10" });
    expect(parseLoadTestInputs({ CONCURRENCY: "5", AMOUNT: "1.5" })).toEqual({
      ok: true,
      concurrency: 5,
      amount: "1.5",
    });
    expect(parseLoadTestInputs({ CONCURRENCY: "0" }).ok).toBe(false);
    expect(parseLoadTestInputs({ CONCURRENCY: String(MAX_CONCURRENCY + 1) }).ok).toBe(false);
    expect(parseLoadTestInputs({ CONCURRENCY: "10; rm -rf /" }).ok).toBe(false);
    expect(parseLoadTestInputs({ AMOUNT: "0" }).ok).toBe(false);
    expect(parseLoadTestInputs({ AMOUNT: "-1" }).ok).toBe(false);
    expect(parseLoadTestInputs({ AMOUNT: "abc" }).ok).toBe(false);
  });

  const settled = (i: number, memo: string): PaymentAttemptResult => ({
    index: i,
    idempotencyKey: `k-${i}`,
    ok: true,
    state: "completed",
    latencyMs: 100,
    stellarTxHash: `h-${i}`,
    memo,
  });

  it("flags a memo that settled twice on chain even when the engine saw one hash", () => {
    const results = [settled(1, "m1"), settled(2, "m2")];
    const txs: OnChainTransaction[] = [
      { hash: "h-1", memo: "m1", createdAt: "2026-11-24T10:00:00Z", successful: true },
      { hash: "h-2", memo: "m2", createdAt: "2026-11-24T10:00:01Z", successful: true },
      { hash: "h-3", memo: "m2", createdAt: "2026-11-24T10:00:02Z", successful: true },
      // Unrelated traffic and failed submissions are ignored.
      { hash: "h-4", memo: "other", createdAt: "2026-11-24T10:00:03Z", successful: true },
      { hash: "h-5", memo: "m1", createdAt: "2026-11-24T10:00:04Z", successful: false },
    ];
    const out = detectOnChainDuplicates(results, txs);
    expect(out.checked).toBe(2);
    expect(out.duplicateMemos).toEqual(["m2"]);
    expect(out.missingMemos).toEqual([]);
  });

  it("reports memos with no on-chain transaction without calling them duplicates", () => {
    const out = detectOnChainDuplicates(
      [settled(1, "m1"), settled(2, "m2")],
      [{ hash: "h-1", memo: "m1", createdAt: "2026-11-24T10:00:00Z", successful: true }],
    );
    expect(out.duplicateMemos).toEqual([]);
    expect(out.missingMemos).toEqual(["m2"]);
  });

  it("pages Horizon back to the start of the run and stops there", async () => {
    const pages: Record<string, unknown> = {
      "https://horizon.test/accounts/GABC/transactions?order=desc&limit=200": {
        _embedded: {
          records: [
            { hash: "a", memo: "m1", created_at: "2026-11-24T10:00:05Z", successful: true },
          ],
        },
        _links: { next: { href: "https://horizon.test/page2" } },
      },
      "https://horizon.test/page2": {
        _embedded: {
          records: [
            { hash: "b", memo: "m2", created_at: "2026-11-24T10:00:01Z", successful: true },
            { hash: "c", memo: "old", created_at: "2026-11-24T09:00:00Z", successful: true },
          ],
        },
        _links: { next: { href: "https://horizon.test/page3" } },
      },
    };
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      const body = pages[url];
      return { ok: body !== undefined, status: body ? 200 : 404, json: async () => body };
    }) as unknown as typeof fetch;

    const txs = await fetchSignerTransactionsSince(
      "https://horizon.test/",
      "GABC",
      new Date("2026-11-24T10:00:00Z"),
      fakeFetch,
    );
    expect(txs.map((t) => t.hash)).toEqual(["a", "b"]);
    expect(seen).toHaveLength(2);
  });
});
