# Custody

**The project never holds your funds, and never holds a key that can move them.**

corridor-in-a-box is software a business runs on its own infrastructure. This page says who
holds the money at each step of a payment, what the project does, and what it does not do. It
is for a business deciding whether to run the engine, and for anyone reviewing it.

Two terms. **The project** is this repository, its maintainers, and anything they operate.
**The business** is whoever runs the engine to send a payment: the operator in the
[threat model](./threat-model.md), and the sending anchor in SEP-31's terms.

## Who holds the money at each step

A payment is one Stellar payment of the bridge asset (USDC, say) from the business to the
receiving anchor. Everything else is HTTP before it and after it.

| Step                               | What happens                                                                                                                       | Who holds the money                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Before the payment                 | The business keeps a working float of the bridge asset in its own Stellar account, the distribution account.                       | The business                                                     |
| `quote`, `comply`, opening the run | The engine asks the receiving anchor for a price, checks KYC status with it, and opens a transaction. Nothing moves.               | The business                                                     |
| `settle`                           | The engine builds one payment from the distribution account to the receiving anchor's account, and the business's signer signs it. | The business until the ledger closes; the receiving anchor after |
| `reconcile`                        | The receiving anchor pays the recipient on its local rail. The engine polls the anchor and checks the payment on the ledger.       | The receiving anchor, then the recipient                         |
| `recover`                          | If the anchor cannot pay out, it is the anchor that sends the money back on chain. Until it does, the run is held for a person.    | The receiving anchor, until it pays out or refunds               |

Two things follow from the `settle` row, and both are by design:

- **Before `settle`, the money has not left the business.** A refused quote, a failed KYC
  check, or a refusal by the pre-settle gate ends the run with the funds where they started.
- **After `settle`, only the receiving anchor can send it back.** A Stellar payment cannot be
  reversed, and SEP-31 gives the sender no refund call. If a payout fails, the anchor refunds
  on its side, or a person settles it with the anchor directly. Neither the engine nor the
  project can pull a payment back. The runbook covers this under
  [why there is no automated refund](./operations.md#why-there-is-no-automated-refund).

If the business buys the bridge asset through an on-ramp before it sends
([RFC 0002](./rfcs/0002-source-side-funding.md)), that on-ramp holds the money until it
delivers it to the distribution account. That is still not the project.

## The one key on the money path

Exactly one key can move the money: the signing key of the business's distribution account.
The business holds it. In production it stays inside the business's own KMS, HSM or Vault,
behind the `ExternalSigner` port. The engine sends the 32-byte transaction hash to be signed
and gets a signature back, so the seed is not in the application process either. See
[key management](./key-management.md).

The project is never given that key, has no copy of it, and has no way to ask for a signature.

## What the project does

- Publishes the engine, its packages and the corridor manifests under Apache-2.0.
- Runs a public registry of what anchors support. It probes their public endpoints and writes
  what it found to two Soroban contracts. The registry holds records, not money. It is on
  testnet today, and [mainnet is planned](./mainnet-registry.md).
- Runs a reference corridor in CI against a test anchor, on testnet only.
- Hosts a demo site with a dashboard and a payment walkthrough. The walkthrough is a
  simulation and never touches the Stellar network.

## What the project does not do

- It does not hold, pool or forward anyone's money, at any step, on any network.
- It does not hold a business's signing key, or any key with authority over an account that
  holds payment funds.
- It does not run a hosted service that takes payments. Each business runs its own engine.
- It is not a party to a payment. The relationship is between the business and the receiving
  anchor.
- It does not act as the regulated party. Licences and KYC belong to the business that sends
  and the anchor that pays out. The engine asks the anchor for KYC status and acts on the
  answer.
- It cannot freeze, reverse, redirect or delay a payment.

## Keys the project does hold

"Never holds keys" means keys that can move a business's or a customer's money. The project
does hold the keys below, and none of them can.

| Key                            | What it can do                                                                                 | What it cannot do                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Attester key                   | Sign the transactions that write probe results to the registry, paying its own fees.           | Sign for any account but its own.                                             |
| Registry admin                 | Rotate the attester, enrol or remove attester keys, set its rate limit, upgrade the contracts. | Touch a business's account or an anchor's.                                    |
| Reference-corridor seeds in CI | Sign testnet payments for the reference run.                                                   | Anything on mainnet: the workflow refuses a manifest that is not for testnet. |

## Real money

Everything the project itself runs is on testnet. A payment with real money happens only when
a licensed business runs the engine as the sending anchor. That business holds the licence,
the signing key and the funds, and the table at the top describes its payment exactly as it
describes a testnet one.

The smart-router design, RFC 0004, fixes this as a rule: the project never holds funds or
keys. This page is that rule in one place.
