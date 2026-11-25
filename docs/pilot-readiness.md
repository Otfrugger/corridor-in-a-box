# Pilot readiness: a checklist for a licensed sending partner

Real money moves through this engine only when a licensed business runs it as the sending
anchor. **That partner holds the licence, the signing key and the funds.** The project
publishes software and holds none of the three.

This is the list to work through before the first real payment, and to keep working through
while the pilot runs. It collects what is already in the [runbook](./operations.md), the
[key-management guide](./key-management.md) and the [threat model](./threat-model.md), in the
order a partner needs it. It is an engineering checklist. It is not legal advice, and it does
not replace the partner's own compliance sign-off.

## Who is responsible for what

| Area                      | The partner                                                    | The receiving anchor                                  | The project                                   |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| Licence and compliance    | Licensed to send. Knows its own senders.                       | Licensed to pay out. Sets the KYC fields it needs.    | None.                                         |
| Funds                     | Holds the float in its own account until `settle`.             | Holds the money from `settle` until payout or refund. | Never holds any.                              |
| Signing key               | Holds it, in its own KMS, HSM or Vault.                        | Holds its own.                                        | Never holds it.                               |
| Running the engine        | Deploys it, configures it, watches it, is on call for it.      | Runs its own SEP services.                            | Publishes the software. Runs nothing for you. |
| A payment that goes wrong | Chases it with the anchor and tells its customer.              | Is the only party that can refund a settled payment.  | Cannot reverse, freeze or redirect a payment. |
| Security problems         | Reports them privately, as [SECURITY.md](../SECURITY.md) says. |                                                       | Fixes them on the latest `main` only.         |

## Before the first real payment

### 1. Agreement and access

- [ ] The partner is licensed for the sending side of this corridor, and whoever owns
      compliance there has signed off the pilot's scope: the corridor, the amounts, how long.
- [ ] There is a signed agreement with the receiving anchor. A lane marked `VERIFIED` only
      means its endpoints answered; it does not mean a business relationship exists.
- [ ] The agreement says how the anchor refunds, how long it takes, and what happens if the
      anchor says it did not receive a payment the ledger shows it did. The threat model lists
      that dispute as an open question, so settle it on paper.
- [ ] The anchor has enabled the partner's Stellar account for SEP-31, and that was checked
      with a real authorised call, not inferred from a public probe. The dry run in section 7
      is such a call: it opens a real SEP-31 transaction.
- [ ] There is a named person at the anchor to call about a stuck payment, with hours.

### 2. Keys

Read [key-management.md](./key-management.md) first. Every item below comes from it.

- [ ] The distribution account's key was created inside the KMS, HSM or Vault and has never
      existed outside it.
- [ ] The service signs through a KMS-backed `ExternalSigner` (`CORRIDOR_SIGNER=vault`, or
      `AwsKmsSigner` / `GcpKmsSigner`). Its environment has no `CORRIDOR_SIGNER_SECRET`.
- [ ] No mainnet seed is in source, a `.env` file, a container image or a CI secret.
- [ ] The signer's permissions are sign-only: get the public key and sign with that one key,
      nothing that creates, deletes, rotates or re-policies a key.
- [ ] `assertSignerProducesValidSignatures` runs before the service accepts work. The shipped
      service does this; custom wiring must too.
- [ ] Testnet and mainnet use different keys.
- [ ] Rotation has been rehearsed on testnet with [runbook §3](./operations.md#3-signing-key-rotation),
      including the drain: the threat model's open question is rotation with payments in
      flight, and the answer for a pilot is that there are none in flight when you rotate.

### 3. Limits

- [ ] The manifest sets `limits.max_amount`. A lane with no ceiling accepts any positive amount
      it is asked for.
- [ ] The distribution account holds only the pilot's working float, topped up from cold
      storage. The float is the most that can be lost if the key or the service is misused.
- [ ] The partner enforces its own daily and per-customer totals before a request reaches the
      engine. The engine caps one payment, not a day's worth: volume quotas across tenants are
      an open question in the threat model.
- [ ] Each caller has its own API key (`CORRIDOR_API_KEYS`), and the rate limit
      (`CORRIDOR_RATELIMIT_CAPACITY`, `CORRIDOR_RATELIMIT_REFILL_PER_SEC`) fits the pilot.

### 4. Safety gates and storage

- [ ] The pre-settle gate is on (`gate: defaultSep31Gate(...)`). `unsafeSkipPreSettleGate` is
      for tests and is not set.
- [ ] Runs are stored in Postgres (`PostgresIdempotencyStore`), `migrate(pool)` has been run,
      and the database is backed up. The in-memory store loses a run on restart.
- [ ] The audit trail is on (`PostgresAuditSink`), and the service's database role can insert
      audit rows but not change or delete them, as [runbook §4](./operations.md#4-database-migrations)
      sets out.
- [ ] The circuit breaker has a health store, so a failing lane stops taking payments instead
      of spending a fee on each retry.
- [ ] The pilot runs one replica, or the limiter and the stores are shared as
      [runbook §5](./operations.md#5-scaling-notes-before-multi-replica) describes.
- [ ] TLS ends at the ingress, and `gracefulShutdown` is wired so a deploy does not cut a
      payment off mid-settle.

### 5. Monitoring

- [ ] `/metrics` is scraped, and the three alerts in [runbook §7](./operations.md#7-metrics--alerting)
      exist and page a person: payments held, payments failed, breaker tripped.
- [ ] `/healthz` and `/readyz` are what the platform uses to decide the service is up.
- [ ] Something outside the engine watches the distribution account's balance. The engine
      refuses a payment the account cannot cover; it does not warn that the float is running low.
- [ ] Logs and the audit table are kept for as long as the partner's regulator requires.

### 6. Refunds and stuck payments

- [ ] Everyone on call has read [why there is no automated refund](./operations.md#why-there-is-no-automated-refund).
      A settled payment cannot be reversed. Only the receiving anchor can send it back.
- [ ] `recovery.rollback` was chosen on purpose, and `recovery.timeout_seconds` and
      `recovery.refund_wait_seconds` suit how fast this anchor really pays out.
- [ ] The team has done the drill on testnet: found a held run with
      `corridor runs list --state held`, recorded its outcome with `corridor runs resolve`,
      and reopened a lane with `corridor breaker status` and `corridor breaker reset`.
- [ ] The partner knows what it will tell a customer whose payment is late, and whose payment
      was refunded.

### 7. Rehearsal

Do these in order. Each one is cheaper than finding the same problem with the next.

- [ ] The whole run passes on testnet with `pnpm verify:corridor`
      ([runbook §1](./operations.md#1-capturing-the-testnet-end-to-end-run)).
- [ ] The mainnet manifest says `network: public`, two people have read it, and the asset
      issuer in it matches the anchor's own `stellar.toml`.
- [ ] `corridor canary <manifest> --amount 1.00 --dry-run` passes against the real anchor. It
      does everything up to the gate and moves no money.
- [ ] One real canary payment completes:
      `corridor canary <manifest> --amount 1.00 --network public --write`.
- [ ] The recipient confirms the money arrived. The anchor's status is the anchor's word; the
      recipient's account is the fact.

**The canary and section 2 pull against each other, so decide this before the day.** The
canary command signs with a raw seed in `CORRIDOR_SIGNER_SECRET`, for the dry run too, and
has no KMS option. The service does (`CORRIDOR_SIGNER=vault`). Two ways to keep the
distribution account's key inside the vault:

- Give the canary an account of its own. Fund it with the canary amount and nothing more, have
  the anchor enable it for the pilot, and throw the seed away afterwards. A canary is refused
  above `proof.canary_max_amount`, which is `10.00` until a lane records one, so that is the
  most such an account can lose.
- Or skip the command on mainnet and send the first payment through the service, which signs
  through the KMS, at the smallest amount the lane allows. This earns no recorded proof, so
  the lane stays `VERIFIED` rather than `PROVEN`.

There is no registry on mainnet yet (`contracts/deployments.json`), so `corridor plan` has no
on-chain attestation to read there. On mainnet the evidence for a lane is the manifest review
and the first payment above.

## While the pilot runs

Each day:

- [ ] No run is `held` without an owner and a date.
- [ ] No lane is halted without someone knowing why (`corridor breaker status`).
- [ ] The float is where it is expected to be, and every payment out of the distribution
      account matches a run in the audit trail.
- [ ] No payment's audit trail has a gap in its versions. A gap means an audit write failed.

## Stop the pilot when

- A run stays `held` longer than the agreement with the anchor allows.
- The breaker trips again for a cause nobody has explained.
- There is any reason to think the signing key was exposed. Stop taking payments, let the ones
  in flight finish, then rotate.
- The KMS or Vault cannot be reached. What should happen then mid-settlement is an open
  question in the threat model; for a pilot the answer is to stop and look at the ledger.
- The ledger and the anchor disagree about a payment.
- The anchor changes its fees or terms after a quote.

## How this was checked against the threat model

| Threat model                       | Where this checklist covers it                                 |
| ---------------------------------- | -------------------------------------------------------------- |
| 1.1 Signing key                    | Section 2; the canary note in section 7; two stop conditions   |
| 1.2 Funds in flight                | Sections 3, 4 and 6; the dispute terms in section 1            |
| 1.3 API keys                       | Section 3, one key per caller                                  |
| 1.4 Registry integrity             | Section 7: no mainnet registry, so the manifest and the canary |
| Operator deploying a bad manifest  | Section 7, two people read it                                  |
| Anchor stalling or denying receipt | Sections 1 and 6, and the stop conditions                      |
| Network attacker                   | Section 4, TLS at the ingress                                  |

Three gaps in the threat model have no control in the software yet, and this checklist covers
them with a person or a document instead: an anchor that denies receipt (the agreement),
volume limits across payments (the partner's own limits), and rotating a key with payments in
flight (drain first).
