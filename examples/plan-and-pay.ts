// Plan a route, then pay it, end to end. Run with: pnpm example:plan-and-pay
//
// Three in-process mock anchors (examples/mock-anchor) serve the same lane,
// corridors/mock.corridor.yaml, each with a different SEP-38 fee. Planning asks
// every one of them for a firm quote through the same Sep31Adapter the engine
// uses, ranks the options by what the recipient receives, and picks the top
// one. Paying hands that choice to execute(): a StaticRouteResolver pinned to
// the winning anchor, and a quote provider that returns the quote the plan was
// ranked on, so the engine settles at the price that won rather than re-quoting.
//
// Offline: the anchors listen on loopback and the mock submitter stands in for
// the Stellar payment, then tells the anchor the funds arrived.

import { fileURLToPath } from "node:url";
import type { Quote } from "@corridor/adapter-kit";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  defaultSep31Gate,
  execute,
  type SettlementSubmitter,
} from "@corridor/engine";
import { compareAmounts, ok, type PaymentIntent } from "@corridor/types";
import { startMockAnchor, type MockAnchor } from "./mock-anchor/server";

const manifestPath = fileURLToPath(
  new URL("../corridors/mock.corridor.yaml", import.meta.url),
);

const ANCHORS = [
  { name: "Mock Anchor A", quoteFee: "0.50" },
  { name: "Mock Anchor B", quoteFee: "0.10" },
  { name: "Mock Anchor C", quoteFee: "0.25" },
];

interface RouteOption {
  readonly anchor: MockAnchor;
  readonly corridor: Corridor;
  readonly adapter: Sep31Adapter;
  readonly quote: Quote;
}

function corridorFor(base: Corridor, name: string, anchor: MockAnchor): Corridor {
  const e = base.dest.endpoints;
  if (!("transfer_server_sep31" in e)) throw new Error("mock manifest is not SEP-31");
  return {
    ...base,
    dest: {
      ...base.dest,
      name,
      endpoints: {
        ...e,
        home_domain: new URL(anchor.url).host,
        transfer_server_sep31: `${anchor.url}/sep31`,
        web_auth: `${anchor.url}/auth`,
        kyc_server: `${anchor.url}/sep12`,
        quote_server: `${anchor.url}/sep38`,
      },
    },
  } as Corridor;
}

async function plan(
  intent: PaymentIntent,
  candidates: ReadonlyArray<{ anchor: MockAnchor; corridor: Corridor }>,
): Promise<RouteOption[]> {
  const options: RouteOption[] = [];
  for (const { anchor, corridor } of candidates) {
    const adapter = new Sep31Adapter(corridor);
    const quoted = await adapter.requestQuote(intent, corridor);
    if (!quoted.ok) {
      console.log(`  ✗ ${corridor.dest.name}: ${quoted.error.code} — ${quoted.error.message}`);
      continue;
    }
    options.push({ anchor, corridor, adapter, quote: quoted.value });
  }
  return options.sort((a, b) => {
    const cmp = compareAmounts(b.quote.destAmount.amount, a.quote.destAmount.amount);
    return cmp.ok ? cmp.value : 0;
  });
}

async function main(): Promise<void> {
  const loaded = loadCorridor(manifestPath);
  if (!loaded.ok) {
    console.error(`manifest error: ${loaded.error.message}`);
    process.exit(1);
  }
  const base = loaded.value;

  const anchors = await Promise.all(
    ANCHORS.map(({ quoteFee }) => startMockAnchor({ quoteFee })),
  );
  try {
    const candidates = anchors.map((anchor, i) => ({
      anchor,
      corridor: corridorFor(base, ANCHORS[i]!.name, anchor),
    }));

    const intent: PaymentIntent = {
      idempotencyKey: "plan-and-pay-0001",
      corridorId: base.id,
      sender: { id: "sender-1", jurisdiction: "US", anchorCustomerId: "cust-sender" },
      recipient: { id: "recipient-1", jurisdiction: "US", anchorCustomerId: "cust-recipient" },
      sourceAmount: { asset: "USDC", amount: "10.00" },
    };

    console.log(
      `planning ${intent.sourceAmount.amount} ${intent.sourceAmount.asset} on corridor "${base.id}" across ${candidates.length} anchors\n`,
    );
    const options = await plan(intent, candidates);
    options.forEach((o, i) => {
      console.log(
        `  ${i + 1}. ${o.corridor.dest.name}  receives ${o.quote.destAmount.amount} ${o.quote.destAmount.asset}  (fee ${o.quote.fee?.amount ?? "0"}, quote ${o.quote.id})`,
      );
    });

    const top = options[0];
    if (!top) {
      console.log("\n✗ no anchor returned a usable quote");
      process.exitCode = 1;
      return;
    }
    console.log(`\npaying via ${top.corridor.dest.name} (${top.anchor.url})\n`);

    const inner = createMockSubmitter();
    const submitter: SettlementSubmitter = {
      ...inner,
      submit: async (req) => {
        const r = await inner.submit(req);
        if (r.ok) top.anchor.markReceived();
        return r;
      },
    };
    const audit = new InMemoryAuditLog();
    const result = await execute(intent, top.corridor, {
      resolver: new StaticRouteResolver(() => top.adapter, {
        trustManifestWithoutAttestation: true,
      }),
      quoteProvider: { source: "sep38", quote: async () => ok(top.quote) },
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
      gate: defaultSep31Gate(),
    });

    if (!result.ok) {
      console.log(`✗ payment failed: ${result.error.code} — ${result.error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log("✓ payment completed");
    console.log(`  anchor:      ${top.corridor.dest.name}`);
    console.log(`  received:    ${top.quote.destAmount.amount} ${top.quote.destAmount.asset}`);
    console.log(`  state:       ${result.value.state}`);
    console.log(`  stellar tx:  ${result.value.stellarTxHash}`);
    console.log(`  trail:       ${result.value.trail.join(" -> ")}`);
    console.log(`  audit:       ${audit.entries.length} transitions recorded`);
  } finally {
    await Promise.all(anchors.map((a) => a.close()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
