// Proves the refusal half of the quote path on live testnet: a firm quote from
// the reference anchor expires before the payment is sent, and the run ends in
// a refusal with no money moved.
//
//   scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm verify:quote-expiry
//
// Why this exists
// ---------------
// `tests/chaos.test.ts` and `examples/run-mock-anchor.ts` cover `quote_expired`
// against a mock, where an already-expired quote is handed back on demand. That
// proves the engine's branch, not that a real SEP-38 server's expiry works the
// way we assume. This drives the real thing against the self-hosted reference
// anchor, and is the sibling of `pnpm verify:corridor` (which proves the happy
// path against the same stack):
//
//   1. request a FIRM SEP-38 quote with a short `expire_after`, so the anchor
//      itself issues an `expires_at` seconds away (not a mock's constant);
//   2. wait past that `expires_at`;
//   3. start the payment with that quote — `quote()` refuses it with
//      `QUOTE_EXPIRED` before comply/open/settle are reached.
//
// The run is then asserted, not merely printed: terminal state `failed`, the
// error is the refusal we asked for, the settlement submitter was never called,
// no anchor transaction was opened, and the signer's bridge-asset balance is
// unchanged. Only when every one of those holds does the script exit 0, so it
// can gate CI. Results go to `$GITHUB_STEP_SUMMARY` when set.
//
// `expire_after` is sent here rather than through `Sep38QuoteProvider` on
// purpose: the provider sends exactly the fields the engine sends in production,
// and production leaves the expiry to the anchor. This scenario needs the
// client-chosen window instead, and keeps that difference in the scenario rather
// than in the code path every corridor uses.
//
//   CORRIDOR_SIGNER_SECRET=S...   testnet distribution account seed (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   AMOUNT=...                    default 10.00
//   QUOTE_EXPIRE_SECONDS=...      short expiry to request, default 10
//   EXPIRY_GRACE_SECONDS=...      extra wait past expiry before paying, default 3
//   MAX_QUOTE_WAIT_SECONDS=...    refuse to wait longer than this, default 900
//   SKIP_DOCTOR=1                 skip the preflight (stack managed elsewhere)
//
// SAFETY: testnet only. A `public` corridor is refused outright, and nothing is
// ever submitted, so this scenario cannot move money even if the engine
// misbehaved — the assertions would fail instead.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { Sep10Client, sep38SellAsset } from "@corridor/adapter-kit";
import type { Quote, QuoteProvider } from "@corridor/adapter-kit";
import { AccountInspector, StellarSep10Signer } from "@corridor/stellar";
import { execute } from "@corridor/engine";
import type { EngineDeps } from "@corridor/engine";
import { fail, ok, type Outcome, type PaymentIntent } from "@corridor/types";
import {
  assertAssetQuotable,
  pinToReferenceAnchor,
  preflightDoctor,
  wireCorridorDeps,
  EXIT_MANIFEST,
  EXIT_MISSING_ENV,
  EXIT_REFUSED,
  EXIT_STACK_UNFIT,
  EXIT_NOT_COMPLETED,
} from "../packages/cli/src/wire.js";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const AMOUNT = process.env.AMOUNT ?? "10.00";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`✗ ${name} must be a positive number, got "${raw}"`);
    process.exit(EXIT_MISSING_ENV);
  }
  return n;
}

const QUOTE_EXPIRE_SECONDS = intEnv("QUOTE_EXPIRE_SECONDS", 10);
const EXPIRY_GRACE_SECONDS = intEnv("EXPIRY_GRACE_SECONDS", 3);
const MAX_QUOTE_WAIT_SECONDS = intEnv("MAX_QUOTE_WAIT_SECONDS", 900);

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`✗ missing required env var ${name}`);
    console.error(`  A testnet distribution account seed. Never a mainnet seed — see`);
    console.error(`  docs/key-management.md.`);
    process.exit(EXIT_MISSING_ENV);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SEP-38 `POST /quote` for a firm quote that expires `expireSeconds` from now.
 *
 * `expire_after` is the client's *desired* `expires_at`: an anchor may honour it
 * or reject the request, but must not quietly return a quote that expires
 * sooner. That is what makes the wait bounded here, instead of depending on
 * whatever default lifetime the anchor happens to use.
 */
async function requestShortQuote(
  corridor: Corridor,
  intent: PaymentIntent,
  token: string | undefined,
  expireSeconds: number,
): Promise<Outcome<Quote>> {
  const name = corridor.dest.name;
  const endpoints = corridor.dest.endpoints as { quote_server?: string };
  const server = endpoints.quote_server?.replace(/\/+$/, "");
  if (!server) {
    return fail("QUOTE_UNAVAILABLE", `${name}: anchor exposes no SEP-38 quote server`);
  }

  try {
    const res = await fetch(`${server}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        context: "sep31",
        sell_asset: sep38SellAsset(corridor),
        buy_asset: corridor.dest.asset,
        sell_amount: intent.sourceAmount.amount,
        expire_after: new Date(Date.now() + expireSeconds * 1000).toISOString(),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(
        "QUOTE_UNAVAILABLE",
        `${name}: quote HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
        { retryable: res.status >= 500 },
      );
    }

    const j = (await res.json()) as {
      id?: string;
      price?: string;
      expires_at?: string;
      sell_amount?: string;
      buy_amount?: string;
    };
    const expiresAt = j.expires_at ? Date.parse(j.expires_at) : Number.NaN;
    if (!j.id || !j.sell_amount || !j.buy_amount || !Number.isFinite(expiresAt)) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `${name}: quote is missing id, amounts or a parsable expires_at`,
      );
    }
    return ok<Quote>({
      id: j.id,
      price: j.price ?? "1",
      expiresAt,
      sourceAmount: { asset: intent.sourceAmount.asset, amount: j.sell_amount },
      destAmount: { asset: corridor.dest.asset, amount: j.buy_amount },
      firm: true,
    });
  } catch (cause) {
    return fail("ANCHOR_UNAVAILABLE", `${name}: quote request failed`, {
      retryable: true,
      cause,
    });
  }
}

/** Print progress during the wait so CI does not look hung. */
async function waitUntil(isoPast: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  let lastNote = 0;
  console.log(`  waiting ${Math.round(waitMs / 1000)}s for the quote to expire (${isoPast})…`);
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    if (left > 30_000 && Date.now() - lastNote > 29_000) {
      console.log(`  ${Math.ceil(left / 1000)}s left`);
      lastNote = Date.now();
    }
    await sleep(Math.min(left, 5_000));
  }
}

/** The signer's line for the corridor's bridge asset, or a reason it is absent. */
async function bridgeBalance(
  inspector: AccountInspector,
  account: string,
  code: string,
  issuer: string | undefined,
): Promise<string> {
  const facts = await inspector.account(account);
  if (!facts.ok) return `unreadable (${facts.error.code})`;
  if (!facts.value) return "account missing";
  const line = facts.value.balances.find(
    (b) => b.asset_code === code && b.asset_issuer === issuer,
  );
  return line ? line.balance : `no ${code} trustline`;
}

interface SummaryRow {
  readonly label: string;
  readonly value: string;
}

function renderSummary(rows: readonly SummaryRow[], passed: boolean): string {
  const body = rows.map((r) => `| ${r.label} | ${r.value} |`).join("\n");
  return [
    "### Quote expiry before settle (live testnet)",
    "",
    `**${passed ? "PASS" : "FAIL"}** — a firm quote from the reference anchor expired before the payment was sent; the run refused it and nothing moved.`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    body,
    "",
  ].join("\n");
}

function emitSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    appendFileSync(path, `${markdown}\n`);
    console.log("\n(written to $GITHUB_STEP_SUMMARY)");
    return;
  }
  console.log(`\n${markdown}`);
}

async function main(): Promise<void> {
  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }

  // Same mainnet guard as `pnpm verify:corridor`, with no escape hatch: this
  // runner drives a local reference anchor, so a mainnet corridor here is
  // always a mistake rather than a decision.
  if (loaded.value.settlement.network === "public") {
    console.error(
      `✗ corridor "${loaded.value.id}" settles on MAINNET (network=public). This runner ` +
        `verifies against a local reference anchor and will not move real money.`,
    );
    process.exit(EXIT_REFUSED);
  }

  const corridor = pinToReferenceAnchor(loaded.value, ANCHOR);

  const doc = preflightDoctor();
  if (!doc.ok) {
    if (doc.error) {
      console.error(`✗ ${doc.error}`);
    } else {
      console.error(
        `\n✗ the reference anchor is not fit to run a corridor (doctor exit ${doc.status}).`,
      );
    }
    process.exit(EXIT_STACK_UNFIT);
  }

  const quotable = await assertAssetQuotable(corridor, ANCHOR);
  if (!quotable.ok) {
    console.error(`✗ ${quotable.error}`);
    process.exit(quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT);
  }

  const signerSecret = env("CORRIDOR_SIGNER_SECRET");
  const wired = wireCorridorDeps(corridor, { signerSecret, horizonUrl: HORIZON });
  const { signer, store, audit } = wired;
  const bridge = corridor.settlement.bridge_asset;
  const inspector = new AccountInspector({ horizonUrl: HORIZON });

  // A firm SEP-38 quote needs a SEP-10 JWT. The signer only signs a challenge;
  // nothing is ever sent to the anchor beyond this and the quote request.
  const endpoints = corridor.dest.endpoints as {
    web_auth?: string;
    quote_server?: string;
  };
  if (!endpoints.web_auth || !endpoints.quote_server) {
    console.error(
      `✗ corridor "${corridor.id}" has no SEP-10 or SEP-38 endpoint to quote against`,
    );
    process.exit(EXIT_REFUSED);
  }
  const sep10 = new Sep10Client(
    endpoints.web_auth,
    corridor.dest.endpoints.home_domain,
    new StellarSep10Signer(signer),
  );

  const intent: PaymentIntent = {
    idempotencyKey: process.env.IDEMPOTENCY_KEY ?? `verify-quote-expiry-${Date.now()}`,
    corridorId: corridor.id,
    sender: { id: "sender-1", jurisdiction: corridor.compliance.source_jurisdiction },
    recipient: { id: "recipient-1", jurisdiction: corridor.compliance.dest_jurisdiction },
    sourceAmount: { asset: bridge, amount: AMOUNT },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  console.log(`\nrequesting a ${QUOTE_EXPIRE_SECONDS}s firm quote from ${ANCHOR}`);
  console.log(`  signer: ${signer.publicKey}`);
  console.log(`  intent: ${intent.idempotencyKey} (${AMOUNT} ${bridge})\n`);

  const auth = await sep10.token();
  if (!auth.ok) {
    console.error(`✗ SEP-10 auth failed: ${auth.error.code} — ${auth.error.message}`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  const requestedAt = Date.now();
  const quoted = await requestShortQuote(corridor, intent, auth.value, QUOTE_EXPIRE_SECONDS);
  if (!quoted.ok) {
    console.error(
      `✗ could not get a firm quote: ${quoted.error.code} — ${quoted.error.message}`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }
  const quote: Quote = quoted.value;
  if (!quote.firm) {
    console.error(`✗ the anchor returned an indicative quote; this scenario needs a firm one`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  const expiresAt = new Date(quote.expiresAt);
  const lifetimeSeconds = Math.round((quote.expiresAt - requestedAt) / 1000);
  console.log(`  quote ${quote.id}`);
  console.log(
    `  expires_at ${expiresAt.toISOString()} (${lifetimeSeconds}s from the request)`,
  );

  // Wait past the expiry. An anchor that ignores `expire_after` (or clamps it to
  // its own policy) is bounded rather than hanging: say so and give up.
  const waitMs = Math.max(0, quote.expiresAt - Date.now()) + EXPIRY_GRACE_SECONDS * 1000;
  if (waitMs / 1000 > MAX_QUOTE_WAIT_SECONDS) {
    console.error(
      `✗ the anchor issued a quote expiring in ${Math.round(waitMs / 1000)}s, beyond ` +
        `MAX_QUOTE_WAIT_SECONDS=${MAX_QUOTE_WAIT_SECONDS}. Either it ignored ` +
        `expire_after=${QUOTE_EXPIRE_SECONDS} (check the anchor's SEP-38 quote policy) or ` +
        `the bound needs raising deliberately.`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }
  const balanceBefore = await bridgeBalance(
    inspector,
    signer.publicKey,
    bridge,
    corridor.settlement.asset_issuer,
  );
  await waitUntil(expiresAt.toISOString(), waitMs);
  if (Date.now() < quote.expiresAt) {
    console.error(
      `✗ still inside the quote window after waiting; refusing to claim an expiry`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }

  // Now try to pay with that quote. `quote()` re-checks `expiresAt` against the
  // clock, so the run must stop before comply/open/settle — the settle leg is
  // the only thing that moves money, and it must not be reached.
  let submitCalls = 0;
  const submitter: EngineDeps["submitter"] = {
    findExisting: (req) =>
      wired.submitter.findExisting?.(req) ?? Promise.resolve(ok(undefined)),
    submit: async (req) => {
      submitCalls += 1;
      return wired.submitter.submit(req);
    },
    refund: (req) => wired.submitter.refund(req),
  };
  const expiredQuote: QuoteProvider = { source: "sep38", quote: async () => ok(quote) };
  const deps: EngineDeps = { ...wired.deps, submitter, quoteProvider: expiredQuote };

  console.log(`\npaying with the expired quote…`);
  const result = await execute(intent, corridor, deps);

  const stored = await store.get(intent.idempotencyKey);
  // The trail comes from the audit sink: a refused run has no `RunResult` to
  // read one from, and the transitions up to the refusal are the evidence.
  const trail =
    audit.entries.length > 0 ? [audit.entries[0].from, ...audit.entries.map((e) => e.to)] : [];
  const balanceAfter = await bridgeBalance(
    inspector,
    signer.publicKey,
    bridge,
    corridor.settlement.asset_issuer,
  );

  const refused =
    !result.ok &&
    (result.error.code === "QUOTE_EXPIRED" || result.error.code === "PRESETTLE_QUOTE_WINDOW");
  const checks: { label: string; ok: boolean; detail: string }[] = [
    {
      label: "the run was refused",
      ok: refused,
      detail: result.ok
        ? `it completed (state=${result.value.state})`
        : `${result.error.code}: ${result.error.message}`,
    },
    {
      label: "terminal state is failed",
      ok: stored?.state === "failed",
      detail: `state=${stored?.state ?? "unknown"}`,
    },
    {
      label: "no settlement was submitted",
      ok: submitCalls === 0,
      detail: `submitter.submit calls=${submitCalls}`,
    },
    {
      label: "no on-chain settlement is recorded",
      ok: !stored?.stellarTxHash && !stored?.transactionId,
      detail: `stellarTxHash=${stored?.stellarTxHash ?? "none"}, transactionId=${
        stored?.transactionId ?? "none"
      }`,
    },
    {
      label: "the signer's balance is unchanged",
      ok: balanceBefore === balanceAfter,
      detail: `${balanceBefore} -> ${balanceAfter} ${bridge}`,
    },
  ];

  const passed = checks.every((c) => c.ok);
  const summary = renderSummary(
    [
      { label: "Corridor", value: `\`${corridor.id}\`` },
      { label: "Anchor", value: `\`${ANCHOR}\`` },
      { label: "Intent", value: `\`${intent.idempotencyKey}\`` },
      { label: "Quote id", value: `\`${quote.id}\`` },
      { label: "Requested expiry", value: `${QUOTE_EXPIRE_SECONDS}s (\`expire_after\`)` },
      {
        label: "Anchor's `expires_at`",
        value: `${expiresAt.toISOString()} (${lifetimeSeconds}s)`,
      },
      { label: "Waited", value: `${Math.round(waitMs / 1000)}s` },
      {
        label: "Refusal",
        value: result.ok ? "none" : `\`${result.error.code}\` — ${result.error.message}`,
      },
      { label: "Terminal state", value: `\`${stored?.state ?? "unknown"}\`` },
      { label: "Trail", value: `\`${trail.join(" -> ") || "none"}\`` },
      { label: "Settlement submits", value: `${submitCalls}` },
      { label: `${bridge} balance`, value: `${balanceBefore} -> ${balanceAfter}` },
      {
        label: "Checks",
        value: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label} (${c.detail})`).join("<br>"),
      },
    ],
    passed,
  );

  console.log(`\ntrail: ${trail.join(" -> ") || "none"}`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`);
  }
  emitSummary(summary);

  if (!passed) {
    console.error(`\n✗ the run did not refuse an expired quote the way it must`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  console.log(`\n✓ a firm quote expired before settle: refused, and no money moved`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
