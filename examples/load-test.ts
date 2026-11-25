// Executes a concurrent load test (100 payments by default) against the
// reference anchor on Stellar Testnet, measuring latency, failure rate, and
// asserting zero duplicate settlements.
//
//   scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm load-test
//
// Environment variables:
//   CORRIDOR_SIGNER_SECRET=S...   testnet distribution account seed (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   CONCURRENCY=...               default 100, must be 1-100
//   AMOUNT=...                    default 0.10, a positive decimal
//   GITHUB_STEP_SUMMARY=...       GitHub Actions step summary file path
//   SUMMARY_FILE=...              alternative markdown summary output path
//   SKIP_DOCTOR=1                 skip the preflight check

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { execute, type EngineDeps } from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";
import {
  assertAssetQuotable,
  pinToReferenceAnchor,
  preflightDoctor,
  registerSep12Customer,
  wireCorridorDeps,
  EXIT_MANIFEST,
  EXIT_MISSING_ENV,
  EXIT_REFUSED,
  EXIT_STACK_UNFIT,
  EXIT_NOT_COMPLETED,
} from "../packages/cli/src/wire.js";

export interface PaymentAttemptResult {
  readonly index: number;
  readonly idempotencyKey: string;
  readonly ok: boolean;
  readonly state: string;
  readonly latencyMs: number;
  readonly stellarTxHash?: string;
  /** The SEP-31 memo the payment settled under, as the run recorded it. */
  readonly memo?: string;
  readonly error?: string;
}

/** One transaction from the signer's account, as Horizon reports it. */
export interface OnChainTransaction {
  readonly hash: string;
  readonly memo?: string;
  readonly createdAt: string;
  readonly successful: boolean;
}

export const MAX_CONCURRENCY = 100;

export interface LoadTestMetrics {
  readonly total: number;
  readonly successful: number;
  readonly failed: number;
  readonly duplicateSettlements: number;
  readonly successRatePercent: number;
  readonly totalDurationMs: number;
  readonly latency: {
    readonly min: number;
    readonly max: number;
    readonly avg: number;
    readonly p50: number;
    readonly p90: number;
    readonly p95: number;
    readonly p99: number;
  };
  readonly errorCounts: Record<string, number>;
  readonly uniqueTxHashes: readonly string[];
}

export function detectDuplicateSettlements(results: readonly PaymentAttemptResult[]): {
  readonly hasDuplicates: boolean;
  readonly duplicateHashes: readonly string[];
  readonly totalSettled: number;
  readonly uniqueSettled: number;
} {
  const settledHashes = results
    .filter((r) => r.ok && r.stellarTxHash)
    .map((r) => r.stellarTxHash as string);

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const hash of settledHashes) {
    if (seen.has(hash)) {
      duplicates.add(hash);
    } else {
      seen.add(hash);
    }
  }

  return {
    hasDuplicates: duplicates.size > 0,
    duplicateHashes: Array.from(duplicates),
    totalSettled: settledHashes.length,
    uniqueSettled: seen.size,
  };
}

/**
 * Counts on-chain settlements per payment memo. A payment that settled twice
 * shows up as two successful transactions from the signer carrying the same
 * memo, even when the engine only remembers one of them. Memos that never show
 * up on chain are reported separately: a completed payment with no on-chain
 * transaction is worth a look, but memo encodings can differ, so it is not
 * treated as a duplicate.
 */
export function detectOnChainDuplicates(
  results: readonly PaymentAttemptResult[],
  transactions: readonly OnChainTransaction[],
): {
  readonly checked: number;
  readonly duplicateMemos: readonly string[];
  readonly missingMemos: readonly string[];
} {
  const memos = new Set(results.filter((r) => r.ok && r.memo).map((r) => r.memo as string));
  const counts = new Map<string, number>();
  for (const tx of transactions) {
    if (!tx.successful || tx.memo === undefined || !memos.has(tx.memo)) continue;
    counts.set(tx.memo, (counts.get(tx.memo) ?? 0) + 1);
  }
  return {
    checked: memos.size,
    duplicateMemos: [...counts].filter(([, n]) => n > 1).map(([m]) => m),
    missingMemos: [...memos].filter((m) => !counts.has(m)),
  };
}

/**
 * Reads the signer's transactions from Horizon, newest first, back to `since`.
 * Bounded by `maxPages` so a busy account cannot keep the job paging forever.
 */
export async function fetchSignerTransactionsSince(
  horizonUrl: string,
  account: string,
  since: Date,
  fetchImpl: typeof fetch = fetch,
  maxPages = 20,
): Promise<readonly OnChainTransaction[]> {
  const out: OnChainTransaction[] = [];
  let url: string | undefined =
    `${horizonUrl.replace(/\/+$/, "")}/accounts/${account}/transactions?order=desc&limit=200`;
  for (let page = 0; url && page < maxPages; page++) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Horizon transactions HTTP ${res.status}`);
    const body = (await res.json()) as {
      _embedded?: {
        records?: { hash: string; memo?: string; created_at: string; successful: boolean }[];
      };
      _links?: { next?: { href?: string } };
    };
    const records = body._embedded?.records ?? [];
    let reachedOlder = false;
    for (const r of records) {
      if (new Date(r.created_at) < since) {
        reachedOlder = true;
        break;
      }
      out.push({
        hash: r.hash,
        memo: r.memo,
        createdAt: r.created_at,
        successful: r.successful,
      });
    }
    if (reachedOlder || records.length === 0) break;
    url = body._links?.next?.href;
  }
  return out;
}

/** Parses CONCURRENCY and AMOUNT, refusing anything outside the safe range. */
export function parseLoadTestInputs(env: {
  CONCURRENCY?: string;
  AMOUNT?: string;
}): { ok: true; concurrency: number; amount: string } | { ok: false; error: string } {
  const rawConcurrency = (env.CONCURRENCY ?? "").trim() || "100";
  if (!/^[0-9]+$/.test(rawConcurrency)) {
    return { ok: false, error: `CONCURRENCY must be a whole number, got "${rawConcurrency}"` };
  }
  const concurrency = Number(rawConcurrency);
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return { ok: false, error: `CONCURRENCY must be between 1 and ${MAX_CONCURRENCY}` };
  }
  const amount = (env.AMOUNT ?? "").trim() || "0.10";
  if (!/^[0-9]+(\.[0-9]{1,7})?$/.test(amount) || Number(amount) <= 0) {
    return { ok: false, error: `AMOUNT must be a positive decimal, got "${amount}"` };
  }
  return { ok: true, concurrency, amount };
}

export function computePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const clampedRank = Math.max(0, Math.min(rank, sorted.length - 1));
  return sorted[clampedRank];
}

export function computeMetrics(
  results: readonly PaymentAttemptResult[],
  totalDurationMs: number,
): LoadTestMetrics {
  const total = results.length;
  const successful = results.filter((r) => r.ok && r.state === "completed").length;
  const failed = total - successful;
  const successRatePercent = total > 0 ? (successful / total) * 100 : 0;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const min = latencies.length > 0 ? latencies[0] : 0;
  const max = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const sum = latencies.reduce((acc, curr) => acc + curr, 0);
  const avg = latencies.length > 0 ? Math.round(sum / latencies.length) : 0;

  const p50 = computePercentile(latencies, 50);
  const p90 = computePercentile(latencies, 90);
  const p95 = computePercentile(latencies, 95);
  const p99 = computePercentile(latencies, 99);

  const errorCounts: Record<string, number> = {};
  for (const r of results) {
    if (!r.ok || r.state !== "completed") {
      const err = r.error ?? r.state ?? "unknown_error";
      errorCounts[err] = (errorCounts[err] ?? 0) + 1;
    }
  }

  const dupCheck = detectDuplicateSettlements(results);
  const duplicateSettlements = dupCheck.totalSettled - dupCheck.uniqueSettled;
  const uniqueTxHashes = Array.from(
    new Set(
      results.filter((r) => r.ok && r.stellarTxHash).map((r) => r.stellarTxHash as string),
    ),
  );

  return {
    total,
    successful,
    failed,
    duplicateSettlements,
    successRatePercent: Math.round(successRatePercent * 10) / 10,
    totalDurationMs,
    latency: { min, max, avg, p50, p90, p95, p99 },
    errorCounts,
    uniqueTxHashes,
  };
}

export function formatMarkdownReport(
  metrics: LoadTestMetrics,
  context?: {
    corridorId?: string;
    concurrency?: number;
    amount?: string;
    anchorUrl?: string;
  },
): string {
  const lines: string[] = [];

  lines.push("## 🚀 Corridor Load Test Summary");
  lines.push("");
  if (context) {
    lines.push(`- **Corridor**: \`${context.corridorId ?? "reference"}\``);
    lines.push(`- **Target Anchor**: \`${context.anchorUrl ?? "reference anchor"}\``);
    lines.push(`- **Concurrent Payments**: \`${context.concurrency ?? metrics.total}\``);
    lines.push(`- **Amount per payment**: \`${context.amount ?? "0.10"} USDC\``);
    lines.push(
      `- **Total Wall-Clock Time**: \`${(metrics.totalDurationMs / 1000).toFixed(2)}s\``,
    );
    lines.push("");
  }

  lines.push("### Execution Overview");
  lines.push("");
  lines.push("| Metric | Value | Status |");
  lines.push("| :--- | :--- | :--- |");
  lines.push(`| Total Payments | ${metrics.total} | ℹ️ |`);
  lines.push(
    `| Successful | ${metrics.successful} | ${metrics.successful === metrics.total ? "✅" : "⚠️"} |`,
  );
  lines.push(`| Failed | ${metrics.failed} | ${metrics.failed === 0 ? "✅" : "❌"} |`);
  lines.push(
    `| Duplicate Settlements | ${metrics.duplicateSettlements} | ${metrics.duplicateSettlements === 0 ? "✅ None (No double-spend)" : "❌ DUPLICATES DETECTED"} |`,
  );
  lines.push(
    `| Success Rate | ${metrics.successRatePercent.toFixed(1)}% | ${metrics.successRatePercent >= 99 ? "✅" : "⚠️"} |`,
  );
  lines.push("");

  lines.push("### Latency Statistics (ms)");
  lines.push("");
  lines.push("| Metric | Latency |");
  lines.push("| :--- | :--- |");
  lines.push(`| Min | ${metrics.latency.min} ms |`);
  lines.push(`| Average | ${metrics.latency.avg} ms |`);
  lines.push(`| Median (p50) | ${metrics.latency.p50} ms |`);
  lines.push(`| 90th percentile (p90) | ${metrics.latency.p90} ms |`);
  lines.push(`| 95th percentile (p95) | ${metrics.latency.p95} ms |`);
  lines.push(`| 99th percentile (p99) | ${metrics.latency.p99} ms |`);
  lines.push(`| Max | ${metrics.latency.max} ms |`);
  lines.push("");

  if (Object.keys(metrics.errorCounts).length > 0) {
    lines.push("### Failure Breakdown");
    lines.push("");
    lines.push("| Error / Failure Reason | Count |");
    lines.push("| :--- | :--- |");
    for (const [err, count] of Object.entries(metrics.errorCounts)) {
      lines.push(`| \`${err}\` | ${count} |`);
    }
    lines.push("");
  }

  if (metrics.uniqueTxHashes.length > 0) {
    lines.push("### Sample Testnet Settlements");
    lines.push("");
    const samples = metrics.uniqueTxHashes.slice(0, 5);
    for (const hash of samples) {
      lines.push(
        `- [\`${hash.slice(0, 16)}...\`](https://stellar.expert/explorer/testnet/tx/${hash})`,
      );
    }
    if (metrics.uniqueTxHashes.length > 5) {
      lines.push(
        `- ... and ${metrics.uniqueTxHashes.length - 5} more unique settlement transactions.`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runConcurrentPayments(
  corridor: Corridor,
  deps: EngineDeps,
  store: {
    get: (
      key: string,
    ) => Promise<
      { state: string; stellarTxHash?: string; memo?: string; lastError?: string } | undefined
    >;
  },
  options: {
    concurrency: number;
    amount: string;
    senderSep12Id: string;
    recipientSep12Id: string;
  },
): Promise<readonly PaymentAttemptResult[]> {
  const { concurrency, amount, senderSep12Id, recipientSep12Id } = options;
  const batchId = Date.now();

  const tasks = Array.from({ length: concurrency }, async (_, idx) => {
    const paymentId = idx + 1;
    const idempotencyKey = `load-test-${batchId}-${paymentId}`;
    const intent: PaymentIntent = {
      idempotencyKey,
      corridorId: corridor.id,
      sender: {
        id: `sender-load-${paymentId}`,
        jurisdiction: corridor.compliance.source_jurisdiction,
        sep12Id: senderSep12Id,
      },
      recipient: {
        id: `recipient-load-${paymentId}`,
        jurisdiction: corridor.compliance.dest_jurisdiction,
        sep12Id: recipientSep12Id,
      },
      sourceAmount: { asset: corridor.settlement.bridge_asset, amount },
      destinationFields: {
        receiver_routing_number: "021000021",
        receiver_account_number: `1234567890${String(paymentId).padStart(4, "0")}`,
        type: "SWIFT",
      },
    };

    const startTime = Date.now();
    try {
      const result = await execute(intent, corridor, deps);
      const latencyMs = Date.now() - startTime;
      const stored = await store.get(idempotencyKey);

      if (result.ok && result.value.state === "completed") {
        return {
          index: paymentId,
          idempotencyKey,
          ok: true,
          state: result.value.state,
          latencyMs,
          stellarTxHash: stored?.stellarTxHash,
          memo: stored?.memo,
        };
      }

      return {
        index: paymentId,
        idempotencyKey,
        ok: false,
        state: stored?.state ?? (result.ok ? result.value.state : "failed"),
        latencyMs,
        stellarTxHash: stored?.stellarTxHash,
        error: !result.ok
          ? `${result.error.code}: ${result.error.message}`
          : stored?.lastError,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        index: paymentId,
        idempotencyKey,
        ok: false,
        state: "exception",
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(tasks);
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

export async function main(): Promise<void> {
  const manifestPath = resolveManifestPath();
  const loaded = loadCorridor(manifestPath);
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }

  // Refuse mainnet corridor
  if (loaded.value.settlement.network === "public") {
    console.error(
      `✗ corridor "${loaded.value.id}" settles on MAINNET (network=public). Load testing refuses to move real money.`,
    );
    process.exit(EXIT_REFUSED);
  }

  const anchorUrl = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
    /\/+$/,
    "",
  );
  const horizonUrl = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  const inputs = parseLoadTestInputs(process.env);
  if (!inputs.ok) {
    console.error(`✗ ${inputs.error}`);
    process.exit(EXIT_REFUSED);
  }
  const { concurrency, amount } = inputs;

  const corridor = pinToReferenceAnchor(loaded.value, anchorUrl);

  if (!process.env.SKIP_DOCTOR) {
    const doc = preflightDoctor();
    if (!doc.ok) {
      console.error(`✗ reference anchor doctor check failed: ${doc.error ?? "unfit stack"}`);
      process.exit(EXIT_STACK_UNFIT);
    }
  }

  const quotable = await assertAssetQuotable(corridor, anchorUrl);
  if (!quotable.ok) {
    console.error(`✗ asset not quotable: ${quotable.error}`);
    process.exit(quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT);
  }

  const signerSecret = process.env.CORRIDOR_SIGNER_SECRET;
  if (!signerSecret) {
    console.error("✗ missing required env var CORRIDOR_SIGNER_SECRET");
    process.exit(EXIT_MISSING_ENV);
  }

  const wired = wireCorridorDeps(corridor, {
    signerSecret,
    horizonUrl,
  });
  const { deps, signer, adapter, store } = wired;

  console.log(`\n======================================================`);
  console.log(`Starting Load Test: ${concurrency} concurrent payments`);
  console.log(`  Corridor:  ${corridor.id}`);
  console.log(`  Anchor:    ${anchorUrl}`);
  console.log(`  Horizon:   ${horizonUrl}`);
  console.log(`  Signer:    ${signer.publicKey}`);
  console.log(`  Amount:    ${amount} ${corridor.settlement.bridge_asset}`);
  console.log(`======================================================\n`);

  const senderReg = await registerSep12Customer(
    adapter,
    "sender",
    corridor.compliance.sep12_sender_type,
  );
  if (!senderReg.ok) {
    console.error(`✗ SEP-12 sender registration failed: ${senderReg.error.message}`);
    process.exit(EXIT_NOT_COMPLETED);
  }
  const receiverReg = await registerSep12Customer(
    adapter,
    "receiver",
    corridor.compliance.sep12_receiver_type,
  );
  if (!receiverReg.ok) {
    console.error(`✗ SEP-12 receiver registration failed: ${receiverReg.error.message}`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  // Horizon timestamps are whole seconds; start the on-chain window a little early.
  const windowStart = new Date(Date.now() - 5_000);
  const startTime = Date.now();
  const results = await runConcurrentPayments(corridor, deps, store, {
    concurrency,
    amount,
    senderSep12Id: senderReg.value,
    recipientSep12Id: receiverReg.value,
  });
  const totalDurationMs = Date.now() - startTime;

  const metrics = computeMetrics(results, totalDurationMs);
  const report = formatMarkdownReport(metrics, {
    corridorId: corridor.id,
    concurrency,
    amount,
    anchorUrl,
  });

  // Acceptance criteria: no duplicate settlements, checked against the ledger,
  // not only against what the engine remembers.
  let onChain: ReturnType<typeof detectOnChainDuplicates> | undefined;
  let onChainError: string | undefined;
  try {
    const txs = await fetchSignerTransactionsSince(horizonUrl, signer.publicKey, windowStart);
    onChain = detectOnChainDuplicates(results, txs);
  } catch (err) {
    onChainError = err instanceof Error ? err.message : String(err);
  }

  const onChainSection = [
    "### On-chain duplicate check (Horizon)",
    "",
    onChain
      ? [
          `- Payment memos checked: ${onChain.checked}`,
          `- Memos settled more than once: ${onChain.duplicateMemos.length}${onChain.duplicateMemos.length ? ` (${onChain.duplicateMemos.join(", ")})` : ""}`,
          `- Memos with no on-chain transaction found: ${onChain.missingMemos.length}`,
        ].join("\n")
      : `- Could not read the signer's transactions from Horizon: ${onChainError}`,
    "",
  ].join("\n");
  const fullReport = `${report}\n${onChainSection}`;

  console.log(fullReport);

  // Write to GitHub Step Summary if present
  const summaryPath = process.env.GITHUB_STEP_SUMMARY ?? process.env.SUMMARY_FILE;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, fullReport + "\n", "utf8");
      console.log(`\n✓ Written report to step summary: ${summaryPath}`);
    } catch (err) {
      console.warn(`Warning: Could not write step summary to ${summaryPath}: ${String(err)}`);
    }
  }

  // Acceptance criteria: No duplicate settlements
  const duplicates = detectDuplicateSettlements(results);
  if (duplicates.hasDuplicates) {
    console.error(
      `\n❌ DUPLICATE SETTLEMENTS DETECTED: ${duplicates.duplicateHashes.join(", ")}`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }

  if (!onChain) {
    console.error(`\n❌ on-chain duplicate check could not run: ${onChainError}`);
    process.exit(EXIT_NOT_COMPLETED);
  }
  if (onChain.duplicateMemos.length > 0) {
    console.error(
      `\n❌ DUPLICATE ON-CHAIN SETTLEMENTS for memo(s): ${onChain.duplicateMemos.join(", ")}`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }

  if (metrics.failed > 0) {
    console.error(`\n⚠️ Load test finished with ${metrics.failed} failure(s).`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  console.log(
    `\n✓ Load test passed: all ${metrics.total} concurrent payments settled with zero duplicates.`,
  );
}

// Run main if called directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
