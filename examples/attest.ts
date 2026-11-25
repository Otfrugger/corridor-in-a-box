// Probe anchors and submit the results to the on-chain registry.
//
//   ATTESTER_SECRET=S... pnpm attest testanchor.stellar.org [more.example ...]
//   ATTESTER_SECRET=S... pnpm attest            # every domain in anchors.json
//   ATTESTER_SECRET=S... pnpm attest --from sweep.json
//
// This is the job the scheduled workflow runs. It probes for real and submits
// exactly what it found — the point of the registry is that nobody, including
// this script, gets to assert a capability that was not observed.
//
// Each domain is written in three calls: the bitmaps, the metadata (the receive
// assets SEP-31 actually listed, plus the country the anchor declared), and the
// receive list again with the amount bounds stated for each asset. The last two
// are skipped when the probe never produced a receive list, because not-recording
// and recording-nothing are different claims.
//
// A deployed attester that predates the third write is not a failed run: the
// first two are still written, and the run warns once that the limits were not.
//
// The signing key must have been enrolled with `add_attester`. Reading the
// registry needs no key at all; see `pnpm registry:read`.

import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
  probeAnchor,
  decodeProbes,
  decodeSeps,
  describeReceiveLimits,
  loadFleet,
  loadProbeResultsFromFile,
  parseAttestArgs,
  type ProbeResult,
} from "@corridor/probe";
import { AnchorAttester, AttesterContractError } from "@corridor/attester";

interface Deployments {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
    attester: string | null;
  };
}

function load<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

async function main(): Promise<void> {
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const cfg = load<Deployments>("../contracts/deployments.json")[network];
  if (!cfg?.attester) {
    console.error(`✗ no attester contract deployed on ${network}`);
    process.exit(1);
  }

  const secret = process.env.ATTESTER_SECRET;
  if (!secret) {
    console.error("✗ set ATTESTER_SECRET to an enrolled attester key");
    process.exit(2);
  }

  const { from, domains } = parseAttestArgs(process.argv.slice(2));

  let results: ProbeResult[];
  if (from) {
    console.log(`loading probe results from ${from}\n`);
    const fileResults = loadProbeResultsFromFile(from);
    results =
      domains.length > 0 ? fileResults.filter((r) => domains.includes(r.domain)) : fileResults;
    if (results.length === 0) {
      console.error(`✗ no matching probe results found in ${from}`);
      process.exit(1);
    }
  } else {
    const targetDomains = domains.length > 0 ? domains : loadFleet().domains;
    results = [];
    for (const domain of targetDomains) {
      results.push(await probeAnchor(domain));
    }
  }

  const attester = new AnchorAttester({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.attester,
    networkPassphrase: cfg.networkPassphrase,
    signer: Keypair.fromSecret(secret),
  });

  console.log(`attesting as ${attester.address} on ${network}`);
  console.log(`contract ${cfg.attester}\n`);

  let failures = 0;
  // Set when the deployed attester turns out to predate `attest_receive`.
  let limitsUnsupported = false;
  for (const result of results) {
    const passed = decodeProbes(result.probesPassed);
    const failed = decodeProbes(result.probesRun).filter((p) => !passed.includes(p));
    console.log(`${result.domain}`);
    console.log(
      `  advertises  ${
        decodeSeps(result.seps)
          .map((n) => `SEP-${n}`)
          .join(", ") || "none"
      }`,
    );
    console.log(`  passed      ${passed.join(", ") || "none"}`);
    console.log(`  failed      ${failed.join(", ") || "none"}`);

    const submitted = await attester.attest(result);
    if (submitted.ok) {
      console.log(
        `  ✓ attested  ${submitted.value.txHash} (ledger ${submitted.value.ledger})\n`,
      );
    } else {
      // A cooldown rejection is the system working, not a failure of the job —
      // don't fail the run over it.
      const cooldown = submitted.error.contractError === AttesterContractError.TooSoon;
      console.log(
        `  ${cooldown ? "•" : "✗"} ${submitted.error.code}: ${submitted.error.message}\n`,
      );
      if (!cooldown) failures += 1;
    }

    // The metadata half, only when the probe actually observed something. An
    // anchor with no working SEP-31 endpoint has no receive list to report, and
    // writing an empty one would record "we asked and it accepts nothing" for a
    // question that was never put.
    if (result.receiveAssets === undefined) continue;
    const meta = await attester.attestMeta(result);
    const declared = result.country ? ` · declared ${result.country}` : "";
    if (meta.ok) {
      console.log(
        `  ✓ meta      ${result.receiveAssets.join(", ") || "no receivable assets"}${declared}` +
          ` — ${meta.value.txHash} (ledger ${meta.value.ledger})\n`,
      );
    } else {
      const cooldown = meta.error.contractError === AttesterContractError.TooSoon;
      console.log(`  ${cooldown ? "•" : "✗"} ${meta.error.code}: ${meta.error.message}\n`);
      if (!cooldown) failures += 1;
    }

    // The same list with the bounds stated for each asset. Once the deployed
    // attester has turned out not to have this write, it is not tried again.
    if (result.receiveLimits === undefined || limitsUnsupported) continue;
    const receive = await attester.attestReceive(result);
    if (receive.ok) {
      console.log(
        `  ✓ limits    ${describeReceiveLimits(result.receiveLimits)}` +
          ` — ${receive.value.txHash} (ledger ${receive.value.ledger})\n`,
      );
    } else if (receive.error.methodMissing) {
      limitsUnsupported = true;
      console.log(`  • limits    not written: ${receive.error.message}\n`);
    } else {
      const cooldown = receive.error.contractError === AttesterContractError.TooSoon;
      console.log(
        `  ${cooldown ? "•" : "✗"} ${receive.error.code}: ${receive.error.message}\n`,
      );
      if (!cooldown) failures += 1;
    }
  }

  if (limitsUnsupported) {
    // Said once and loudly, not once per domain: a run that quietly skips a
    // third of what it was asked to write is how a registry falls behind.
    const warning =
      "receive limits were not written for any domain: attest_receive is not deployed. " +
      "upgrade() the registry and the attester to record them.";
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::warning::${warning}` : warning);
  }

  if (failures > 0) {
    console.error(`${failures} of ${results.length} attestations failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
