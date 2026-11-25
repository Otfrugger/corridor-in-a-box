# Roadmap

This project is a **walking skeleton**: the orchestration is real and tested
against mocks, but the money-moving paths and durability are being filled in.
The list below is roughly the order in which the skeleton becomes a beta-grade
system. Items marked ✅ are done. The last section is the wave-11 plan: workstreams
that run side by side, each item linked to the issues it is made of.

## Phase 1 — Move real money on testnet

- ✅ SEP-10 challenge/response auth in the SEP-31 adapter (`authToken()`).
- ✅ SEP-12 KYC handoff against `kyc_server`.
- ✅ A real `SettlementSubmitter` on `@stellar/stellar-sdk` (build → sign →
  submit a native payment, watch Horizon).
- ✅ The settle leg executed against **live Stellar testnet** — build → sign →
  submit → confirm on Horizon, reproducible via `pnpm verify:settle`. Captured
  tx: [`855933c7…08dfd245`](https://stellar.expert/explorer/testnet/tx/855933c73b85b9071318ff0bfd9213096a1edfaef68417dea1c2e8fb08dfd245)
  (ledger 4024693, 2026-08-07). This is the settle leg **only** — no anchor is
  involved, so it is not yet a corridor run.
- ✅ SEP-10 auth, SEP-12 registration (both parties), SEP-38 firm quote and
  SEP-31 `POST /transactions` all executed against the **Anchor Platform
  reference server** running locally (`scripts/reference-anchor.sh up`), with
  the settle leg landing 10 USDC on its deposit address — tx
  [`4aea2432…`](https://stellar.expert/explorer/testnet/tx/4aea2432696c43104662fea98c86cecdfb12e2e831426e3a90e616eb7f183897),
  ledger 4030910, correctly attributed by hash memo. Captured in the README.
- ✅ `reconcile → completed` against a real counterparty. The run above reaches
  `settled` and then polls: the reference server's Stellar observer sat on a
  stale cursor, never matched the payment, and left the transaction at
  `pending_sender`. The engine's timeout/recovery path is what ran. **This leg
  remains unproven end to end** and is the last open Phase-1 item.
  _Update (2026-09-01):_ cursor seeding fixed in #65 — `reference-anchor.sh up`
  reseeds the observer cursor from Horizon's tip, #66 added `doctor`'s
  cursor-lag check, and #67/#75 added `pnpm verify:corridor` and the scheduled
  [`reference-corridor`](https://github.com/corridor-in-a-box/corridor-in-a-box/actions/workflows/reference-corridor.yml)
  workflow. The pending proof is that workflow going green; it currently fails,
  so this item stays ⬜.
  _Update (2026-10-24):_ the failure it had was the signer draining
  (`op_underfunded`): the workflow now tops the signer up first (#297), and a manual
  run settles (tx
  [`757341…`](https://stellar.expert/explorer/testnet/tx/757341861311f52f6feaf8a1f307215c77acfd3238779d184911a0579d448b42)).
  It still ends red: after settling, the reference anchor's status poll returns `error`
  for about 15 minutes, so the run goes `settled → recovering → held`. That is the open
  question, and it stays ⬜.
  _Update (2026-11-16):_ **closed.** That `error` was our own label for a failed poll:
  `getTransaction` polled `GET /transactions/:id` without the SEP-10 token and got
  403 every time. With that fixed, two harness problems surfaced and were fixed in the
  same PR: the image's shared distribution account had been merged by a stranger
  (its seed is public), so the anchor now receives on an account only this repo
  holds; and the reference server never pays SEP-31 out by itself, so
  `reference-anchor.sh payout-watch` triggers its payout endpoint, playing the
  anchor's operator. [Run 43969161708](https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/43969161708) went
  `… → settled → reconciled → completed`, settle tx
  [`81c46422…`](https://stellar.expert/explorer/testnet/tx/81c4642216b884100b34fa018462bb9cd7587886307d59d923dccbf87011b630) (10 USDC, ledger 5768820). Scope: this is the self-hosted
  reference anchor with its fiat payout simulated, not a third-party anchor.

## Phase 2 — Durability & correctness

- ✅ Decimal-safe `Money` arithmetic (no float, explicit rounding).
- ✅ Durable idempotency store (Postgres) + crash-resume of in-flight runs.
- ✅ `reconcile` polls until settled/timeout; `recovery.timeout_seconds`
  enforced; retry backoff.
- ⬜ Real refund path (reverse settlement). **Not implemented**, and the engine
  never calls `requestRefund`. `StellarSettlementSubmitter.refund()` unconditionally
  returns a non-retryable failure — an already-credited payment cannot be reversed
  unilaterally on chain, which is correct behaviour. A genuine refund means the
  receiving anchor initiating one on its own side — SEP-31 gives the sender no endpoint
  to trigger one, so this is an operational arrangement with the anchor, not an API
  call (the full reasoning lives in [the operations runbook](./docs/operations.md)).
  What ships today is the watch and the escalation, not the reversal: after a
  payment has gone out and the anchor reports a terminal failure, the run enters
  `refund_pending` and the engine polls for the anchor's own refund report (`refunded`
  on a full report; `held` on a partial one or after `recovery.refund_wait_seconds`).
  Wave 11 runs that watch against a live testnet anchor ([#674]).

## Phase 3 — Operability (required before close beta)

- ✅ Structured logging + append-only audit trail of every state transition.
- ✅ Metrics / tracing hooks (injectable `Metrics`; per-verb timings + counters).
- ✅ Signing-key management: an `ExternalSigner` port with Vault Transit, AWS KMS and
  Google Cloud KMS implementations, and [docs/key-management.md](./docs/key-management.md).
- ✅ A thin service/API layer (`@corridor/service`: HTTP over the engine, with
  API-key auth and rate limiting).
- ✅ A runnable launcher for `@corridor/service` (`pnpm serve` →
  `examples/run-service.ts`), serving every corridor manifest with the same
  mainnet safety guard as `pnpm testnet`.
- ✅ OpenTelemetry adapters for the `Metrics` and `Logger` ports (`@corridor/otel`),
  and a Redis token bucket for a fleet-wide rate limit (`RedisTokenBucket`).
- ✅ An OpenAPI 3.1 spec for the service, tested against the real `route()`.
- ✅ A container image (`Dockerfile`), smoke-tested in CI and published to GHCR on
  release tags; coverage floors enforced in CI; every library package builds to
  `dist/` with type declarations; and a one-tag release workflow. Cutting the first
  `vX.Y.Z` tag is a maintainer action: it needs a `CHANGELOG.md` section for the version.
- ✅ A scriptable mock anchor (`pnpm mock:anchor`) that stalls, rejects KYC, errors
  after settle or refunds on demand, for running a whole corridor locally.
- ✅ Nightly CI job re-running the live-anchor probe
  (`tests/integration/sep31-live.test.ts`), running against `testanchor.stellar.org`
  by default; only the SEP-10/SEP-12 legs need `CORRIDOR_SIGNER_SECRET`.

## Phase 4 — Corridors

- ✅ Corridor #1 manifest for a live SEP-31 receive-side anchor.
  `ng-cowrie.corridor.yaml` — Cowrie Exchange (Lagos, Nigeria), confirmed
  2026-08-11 by running `@corridor/probe` for real against its production API:
  SEP-10 challenge signed and exchanged for a JWT, SEP-12 answered, SEP-31
  `/info` returned a non-empty receive list (NGNT, USDC). `endpoints_verified_at`
  is set and `corridor plan` reports it `VERIFIED`. `mx-example.corridor.yaml`
  remains a fictional template for a _different_ lane (Mexico) and is
  unaffected. What this does NOT mean: no payment has been attempted, Cowrie
  publishes no SEP-38 quote server (`quote_source: external`), and there is no
  KYC'd business relationship with Cowrie backing this — see the manifest's
  `status_note`.
- ✅ Corridor #2: `zeam.corridor.yaml` — Zeam (South Africa), probed 2026-10-17:
  SEP-10, SEP-12, SEP-31 and SEP-38 all answer, so it is the first lane with a firm-quote
  path. Same caveats as #1: no payment attempted, no business relationship.
- ✅ A SEP-6 lane: `testanchor-sep6.corridor.yaml`, the SDF test anchor on testnet.
  [`corridors/README.md`](./corridors/README.md) catalogues every manifest.
- ⬜ Additional real corridors as off-ramps come online. Wave 11 grows the fleet region by
  region ([#664], [#665], [#666], [#667]) and scaffolds a corridor from any attested anchor
  ([#670]).
- ⬜ `ng-cn` becomes runnable the day a compliant RMB SEP-31 off-ramp exists. The search for
  anchors in the region continues in [#666].

## Phase 5 — Grant-maturity / protocol depth (after wave entry)

- ⬜ Demonstrate all four SEP flows (SEP-10, SEP-12, SEP-31, SEP-38) against a
  live anchor, with tests. Wave 11 attempts it with Zeam, the one anchor that answers all
  four ([#682]).
- ⬜ SCF Tier-2 grant proposal — structure and milestones drafted in
  [docs/grant-proposal.md](./docs/grant-proposal.md); budget figures and
  submission still pending maintainer input.
- ⬜ First payment on a VERIFIED corridor (ng-cowrie) — blocked on a KYC'd business
  relationship. Wave 11 attempts a sandbox payment ([#683]) and writes down what Cowrie asks
  of a sender ([#641]).

## Wave 11 — the smart router and the road to mainnet

Phases 1 to 5 made one corridor run: the caller names it, and the engine runs it. Wave 11
changes the question from "run this corridor" to "what is the best way to get this amount to
this country", and takes the first steps toward mainnet. These are workstreams that run side
by side, not ordered phases.

Every item is open and links the issues it is made of; the acceptance criteria live there.
The design reference is [RFC 0004, the smart router](docs/rfcs/0004-smart-router.md).

### Smart router

- ⬜ A planner that starts from an amount and a destination and narrows the corridors down:
  the types ([#603]), candidates by asset and country ([#604]), the registry evidence filter
  ([#605]), limits and required fields ([#606]), the circuit breaker ([#607]), lane state
  ([#636]), SEP-6 only where third-party payout is allowed ([#645]) and the labels a business
  permits ([#615]).
- ⬜ A price on every option, labelled for what it is: `locked` from a firm quote ([#608]),
  `indicative` from a published price ([#609]) or `estimated` from history ([#610]), fetched
  from all candidates at once ([#614]).
- ⬜ A ranking anyone can check: the ranking function ([#611]), reliability from the
  business's own payments ([#612]), a reason on every option ([#613]) and a conformance kit
  for outside planners ([#616]).
- ⬜ Ways to ask for routes and pay the one chosen: `POST /routes` ([#617]), a chosen option
  on `POST /payments` ([#618]), the route and label on payment status ([#629]), a
  `corridor routes` command ([#619]), a runnable example ([#621]) and the guide ([#620]).
- ⬜ An engine that keeps to the choice: a supplied quote used as it is ([#622]), an expired
  one refused ([#623]), the route stored with the run ([#624]) and resolved only to that
  ([#625]), a fallback before funds move and never after ([#626]), the choice in the audit
  trail ([#628]) and the cost of a guaranteed estimate recorded ([#627]).
- ⬜ Documents that say what the code does: `route-resolver.md` ([#630]), the README in plain
  words ([#705]), a glossary ([#706]), the threat model ([#704]) and this roadmap ([#708]).

### Rate history

- ⬜ Prices collected over time: the schema ([#589]), anchors' SEP-38 prices ([#590]), Stellar
  DEX trades ([#591]), a reference FX source whose licence allows republishing ([#592]), the
  rate our own payments achieved ([#594]) and an always-on collector ([#593]).
- ⬜ What is worked out from them: percentile and window helpers ([#597]), a daily summary per
  pair ([#595]), the minimum data an estimate needs ([#598]), outliers flagged ([#602]) and
  retention ([#599]).
- ⬜ Published, so the numbers the router uses can be checked: the summaries on the web app
  ([#596]), a chart per pair ([#600]) and the documentation of sources, cadence and licences
  ([#601]).

### Lane checks

- ⬜ Whether a receiver accepts this business, found out before a payment and not during one:
  a SEP-10 login with the business's own key ([#631]), an authorised `/sep31/info` call
  ([#632]), results cached and re-checked daily ([#633]), a manual override ([#634]) and
  "probably open" kept apart from confirmed ([#635]).
- ⬜ A design for public on-chain lane records that a receiver opts into ([#643]).

### Onboarding

- ⬜ A company profile a sending business fills in once: the schema ([#637]), a validator and
  CLI command ([#638]), an exporter framework ([#639]) and the first exporter, for the
  self-hosted reference anchor ([#640]).
- ⬜ What real anchors ask for, and a guide: the public requirements of Cowrie, Zeam and MyKobo
  ([#641]) and the onboarding guide ([#642]).

### More anchors and route types

- ⬜ A larger fleet, region by region: Africa ([#664]), Latin America ([#665]), Asia-Pacific
  ([#666]) and Europe ([#667]), with a way for an anchor to ask to be listed ([#671]) and a
  corridor scaffolded from any attested anchor ([#670]).
- ⬜ Why the anchors already listed fail the probe, and whether they can receive: MyKobo
  ([#650]), BlindPay ([#651]), ClickPesa ([#652]), Coins.ph ([#653]), Anclap ([#654]), Mercuryo
  ([#655]), Lightnet ([#656]), OwlPay ([#657]), Arf ([#658]), Banxa ([#659]), Flutterwave
  ([#660]), Bitso ([#661]) and MoneyGram Access ([#223]).
- ⬜ A probe and a registry that say more: why a `stellar.toml` fetch failed ([#662]), a
  descriptive User-Agent ([#663]), receive assets in the registry ([#669]), upgrade tooling
  and a preflight for the nightly attestation ([#584]), an honest anchor card when the toml
  could not be fetched ([#585]) and dashboard filters ([#668]).
- ⬜ Routes beyond SEP-31: a `third_party_payout` flag for SEP-6 corridors ([#644]) with a
  testnet payout run ([#649]), and a wallet route type, from its manifest ([#646]) to
  settlement ([#647]) and the trustline check ([#648]).

### Proof on testnet

- ⬜ The failures that matter, run live: a firm quote that expires ([#672]), an anchor asking
  for more customer information ([#673]), a payout that fails and is refunded ([#674]), an
  anchor down mid-flow ([#675]), amounts outside the limits ([#676]) and a crash and resume
  ([#677]), with failure injection in the reference anchor ([#678]).
- ⬜ A nightly run that proves more and shows it: three amounts ([#679]), a machine-readable
  history ([#680]), the latest real payment on the dashboard ([#586]) and a load test of 100
  concurrent payments ([#681]).
- ⬜ A first attempt against real anchors: Zeam ([#682]) and Cowrie ([#683]).
- ⬜ A send app to fork: the scaffold ([#684]), the amount and destination form ([#685]), route
  options ([#686]), a countdown for locked prices ([#687]), recipient details ([#688]), a
  progress timeline ([#689]), a server-side proxy ([#690]), error states ([#691]), an
  accessibility pass ([#692]), an end-to-end test ([#693]) and a starter guide ([#694]).
- ⬜ A service an integrator can rely on: API key rotation ([#266]), a paginated
  `GET /payments` ([#267]) and docs that match the walkthrough, with a link check in CI
  ([#587]).

### Mainnet steps

- ⬜ Somewhere for it to run: an always-on host for the testnet service and the collector
  ([#695]).
- ⬜ The registry on mainnet: a deployment script ([#696]), the entry criteria brought up to
  date ([#697], [#698]), a read-only probe workflow ([#699]), deployments recorded
  ([#701]), the dashboard switching networks ([#700]) and rate history on mainnet prices
  ([#702]).
- ⬜ What a licensed partner needs before a pilot: a readiness checklist ([#703]) and a custody
  statement ([#707]).

[#223]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/223
[#266]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/266
[#267]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/267
[#584]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/584
[#585]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/585
[#586]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/586
[#587]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/587
[#589]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/589
[#590]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/590
[#591]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/591
[#592]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/592
[#593]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/593
[#594]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/594
[#595]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/595
[#596]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/596
[#597]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/597
[#598]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/598
[#599]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/599
[#600]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/600
[#601]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/601
[#602]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/602
[#603]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/603
[#604]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/604
[#605]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/605
[#606]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/606
[#607]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/607
[#608]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/608
[#609]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/609
[#610]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/610
[#611]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/611
[#612]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/612
[#613]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/613
[#614]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/614
[#615]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/615
[#616]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/616
[#617]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/617
[#618]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/618
[#619]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/619
[#620]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/620
[#621]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/621
[#622]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/622
[#623]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/623
[#624]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/624
[#625]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/625
[#626]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/626
[#627]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/627
[#628]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/628
[#629]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/629
[#630]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/630
[#631]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/631
[#632]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/632
[#633]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/633
[#634]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/634
[#635]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/635
[#636]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/636
[#637]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/637
[#638]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/638
[#639]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/639
[#640]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/640
[#641]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/641
[#642]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/642
[#643]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/643
[#644]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/644
[#645]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/645
[#646]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/646
[#647]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/647
[#648]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/648
[#649]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/649
[#650]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/650
[#651]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/651
[#652]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/652
[#653]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/653
[#654]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/654
[#655]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/655
[#656]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/656
[#657]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/657
[#658]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/658
[#659]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/659
[#660]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/660
[#661]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/661
[#662]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/662
[#663]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/663
[#664]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/664
[#665]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/665
[#666]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/666
[#667]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/667
[#668]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/668
[#669]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/669
[#670]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/670
[#671]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/671
[#672]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/672
[#673]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/673
[#674]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/674
[#675]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/675
[#676]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/676
[#677]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/677
[#678]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/678
[#679]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/679
[#680]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/680
[#681]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/681
[#682]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/682
[#683]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/683
[#684]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/684
[#685]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/685
[#686]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/686
[#687]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/687
[#688]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/688
[#689]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/689
[#690]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/690
[#691]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/691
[#692]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/692
[#693]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/693
[#694]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/694
[#695]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/695
[#696]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/696
[#697]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/697
[#698]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/698
[#699]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/699
[#700]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/700
[#701]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/701
[#702]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/702
[#703]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/703
[#704]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/704
[#705]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/705
[#706]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/706
[#707]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/707
[#708]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/708

See [CONTRIBUTING.md](./CONTRIBUTING.md) for good first issues.
