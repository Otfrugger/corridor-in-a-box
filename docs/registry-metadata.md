# Design: country and receive-asset metadata on registry records

Status: agreed and implemented. Answers #241; the code is #242. Decision 6, the
amount bounds on the receive list, came later with #669.

## The problem

`AnchorRecord` (`contracts/registry/src/lib.rs`) holds SEP bitmaps, a toml hash,
an attested ledger and an attester. It can answer "does this anchor advertise
SEP-31 and did a SEP-31 probe pass" but not the two questions an operator asks
next: _which anchors pay out NGN_, and _which anchors serve Kenya_.

The contract header says the registry holds facts, not opinions, so any new field
has to be classifiable as one of two kinds before it can be stored:

- **observed** — a probe called an endpoint and this is what came back. Nobody's
  claim; it is a measurement.
- **declared** — the anchor's own `stellar.toml` says it. Unverified, and
  unverification is the point: an anchor that lies about where it is incorporated
  is doing something the registry should record, not silently correct.

The two kinds must not share a field, because a consumer weights them
differently. That is the same split the contract already draws between `seps`
(advertised) and `probes_passed` (verified).

## Decisions

### 1. Receive assets: `Vec<String>` of codes, observed

Three options were on the table: a hash, a bitmap over a fixed asset list, or the
codes themselves.

A hash is cheap and useless. "Which anchors receive NGN" is exactly the query the
registry exists to answer, and a hash cannot be queried — only compared against
another hash someone already knows.

A bitmap over a fixed asset list is the cheapest to store and the fastest to read,
and it is what `seps` does. It loses here because the asset list is not closed.
`SEP_NUMBERS` has seven entries and grows one at a time by deliberate upgrade;
fiat and asset codes are in the hundreds and every anchor adds more. Either the
list goes stale and unlisted assets are silently unrepresentable, or the bitmap's
meaning shifts under consumers on every upgrade.

So: the codes, as `Vec<String>`, bounded. The read cost is the list, and the list
is capped (below) so the read cost is capped too. Storage is paid once per
attestation and the query is paid by whoever asks; a bitmap would make every
consumer pay for an enumeration it cannot express.

Codes are stored as the anchor's SEP-31 `/info` response keyed them, verbatim.
No normalisation: `NGN` and `iso4217:NGN` can genuinely be different entries on a
real endpoint, and picking one would be this registry inventing a fact.

### 2. Country: declared, ISO-3166-1 alpha-2, nullable

The only machine-readable source is the toml: `[DOCUMENTATION]
ORG_PHYSICAL_ADDRESS` and, less reliably, the anchor asset fields under
`[[CURRENCIES]]`. A currency is not a country — anchors serve diaspora corridors,
so `USD` on a toml says nothing about where the anchor is.

So the field is the country derived from `ORG_PHYSICAL_ADDRESS`, stored as an
ISO-3166-1 alpha-2 code and labelled for what it is: `AnchorMeta.country` sits
beside `receive_assets`, and the doc comment on the struct says which is observed
and which is declared. A `None` country means "the toml had nothing machine-
readable in it", not "this anchor has no country".

Two-letter rather than a free-text name, so consumers can group on it without
normalising `"Nigeria"`, `"Nigeria."` and `"NG"` into the same bucket by hand. The
contract rejects anything that is not two uppercase ASCII letters, so the
normalisation happens once, in the probe, or the value is not written at all.

The probe refuses to guess. It accepts a toml that declares a country only in a
form it can map to an alpha-2 code without a judgement call: an alpha-2 code, an
alpha-3 code, or a name in a fixed allowlist of jurisdictions this project
actually probes. Anything else yields `None` and is not written. A declared field
is acceptable on chain precisely because nobody is improvising its meaning at read
time.

### 3. SEP-24 / SEP-6 withdraw assets: not in this change

Same shape, different observation: a SEP-6 withdraw list is a different endpoint
answering a different question, and an anchor that withdraws `NGN` and receives
`NGN` was observed doing two things. Folding them into one list would lose that,
and adding a second list today would be speculative — the queries in #242 are
receive-side.

The layout anticipates the addition without requiring it: one `Meta` key per
domain holding a struct, so a withdraw list is a new field on `AnchorMeta` and a
new reader, not a new key or a migration.

That last sentence did not survive #669. A stored struct is decoded by its exact
set of fields, so a field added to `AnchorMeta` makes every entry written before
it unreadable (decision 6 has the details and the test). A withdraw list, when a
query needs one, should get its own key the way the receive limits did.

### 4. Schema evolution: a separate `DataKey::Meta(String)`

A struct version on `AnchorRecord` was the alternative. Rejected:

- Every existing record would either have to be rewritten (a migration the
  contract cannot perform, because only the attester may write) or carry a
  version flag consumers must branch on forever.
- A new field inside `AnchorRecord` means `put_anchor` must carry it, which
  changes the signature the already-deployed attester contract calls — and an
  attester running the current client would revert the moment the registry
  upgraded.

Under a separate key, nothing that exists changes shape. A pre-upgrade record
keeps answering `get_anchor` exactly as before, and `get_meta` answers `NotFound`
for it. `NotFound` is the honest answer: "nobody has observed the receive list"
and "it receives nothing" are different facts, and an empty default would let the
first become evidence for the second.

The same reasoning gives the writer path its shape: `attest_meta` is a new method
on the attester, not new arguments on `attest`, and it relays to a new
`put_meta`. A sweep therefore submits two transactions per domain instead of
one. That is deliberate — the extra fee buys the property that a probe which could
not read an anchor's `/info` still gets its bitmaps on chain, and that an
attester written against the old signature keeps working through the upgrade.

Because the two halves are separate writes, they are rate limited separately
(`LastAttest` and `LastMeta` on the attester). A shared cooldown would make the
second half of every sweep fail with `TooSoon` in the same ledger the first half
succeeded, which is a bug dressed up as a policy.

`bump(domain)` extends both entries when metadata exists. Metadata left on its own
clock would archive quietly beside a record that keeps getting bumped, and the
result is a domain that answers `get_anchor` forever while `get_meta` has gone.

### 5. Bounds

| Bound                | Value | Why this number                                                                                                           |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `MAX_RECEIVE_ASSETS` | `32`  | An anchor with more receivable codes than this has lanes nobody can route. Also caps the size of a `get_meta` read.       |
| `MAX_ASSET_CODE_LEN` | `32`  | Real codes are 3–12 characters; the slack fits a quoted `iso4217:NGN`-style form without letting the field become a blob. |
| `COUNTRY_CODE_LEN`   | `2`   | ISO-3166-1 alpha-2, fixed rather than ranged, so it is comparable without normalising and cannot hold an address line.    |
| Country casing       | upper | Normalising on write would mean two spellings of one country can be written and only one read back.                       |

Plus two structural rules, both because they make a stored number a lie rather
than merely ugly: an empty asset code is refused, and a code repeated in one write
is refused, since `receive_assets.len()` is read as a count of assets an anchor
receives.

Ordering is not constrained. The list is what an endpoint returned; re-sorting on
write would rewrite the observation.

`AnchorMeta` carries its own `attested_ledger` and `attester` for the same reason
the record does: metadata from last week is not evidence about today.

### Where the bounds are checked

Both contracts. `put_meta` validates, because the registry does not store what it
is handed — that is its whole credibility. `attest_meta` validates the same bounds
first, because a revert inside the cross-contract call surfaces the registry's
error numbering to a caller that addressed the attester, and
`AttesterContractError` would read a registry code as an attester code meaning
something else.

The mirroring is a real risk, so it is pinned: `contracts/attester/src/test.rs`
asserts the attester's constants equal the registry's. The attester crate cannot
import them — linking the registry into its wasm collides on `__constructor`, see
`RegistryInterface` in that file.

### 6. Receive limits: a third key, amounts as scaled integers (#669)

`receive_assets` says which assets an anchor takes. A planner also needs to know
how much: SEP-31 `/info` states a `min_amount` and a `max_amount` beside each
asset, and without them every candidate lane costs a call to the anchor just to
learn that the amount does not fit. So the receive list is recorded a second
time, with those bounds, and read in one call.

**A third key, `DataKey::Receive(String)`, not new fields on `AnchorMeta`.** This
one is not a matter of taste. Soroban decodes a stored struct by its exact set of
fields: read an entry as the same struct with one more field, even an optional
one, and the host refuses with `Error(Object, UnexpectedSize)`, which inside a
contract is a trap. Every `Meta` entry written before the change would stop
answering `get_meta` until someone rewrote it, and only the attester can write.
`a_stored_struct_cannot_gain_a_field` in `contracts/registry/src/test.rs` shows
the failure, and `metadata_stored_before_the_receive_list_existed_still_reads`
fails the day someone adds a field to `AnchorMeta` anyway. The rule that follows:
`DataKey` is append-only, and so are the structs it points at.

The new entry repeats the asset codes that `Meta` holds. That is deliberate: it
is one observation of one response, self-contained, on its own clock. The two
entries are written by separate calls and can disagree for a while, and each
carries its `attested_ledger` so a reader can see which is newer.
`receives_asset` still answers from `Meta`.

**Amounts are `Option<i128>`, scaled by 10^7.** Seven decimal places is the
precision Stellar carries (`AMOUNT_DECIMALS`), so a bound and the payment it is
compared with are in the same unit. `None` means no bound was recorded. It does
not mean a minimum of zero or an unlimited maximum, and a stated zero is stored
as zero.

**Nothing is rounded.** The probe records a bound only when it can be written on
that scale exactly: a JSON number or a plain decimal string, not negative, at
most seven decimal places, and for a JSON number at most 15 significant digits,
since past that the digits are the float's and not the anchor's. Anything else is
left out, the asset stays in the list, and the entry reads "no bound recorded".
Rounding a minimum down or a maximum up would put a number on chain that the
anchor never gave.

**A minimum above the maximum is stored as observed.** It is what the endpoint
said, and a reader comparing an amount against the pair gets the right answer
from it: nothing fits. A negative bound is refused (`InvalidAmount`: registry
`#11`, attester `#9`), because an amount cannot be negative and so it can only be
a writer's mistake.

| Rule         | Value                | Why                                                                            |
| ------------ | -------------------- | ------------------------------------------------------------------------------ |
| Entries      | `MAX_RECEIVE_ASSETS` | The same ceiling as the code list: this is the same list.                      |
| Code         | as in `Meta`         | Non-empty, at most `MAX_ASSET_CODE_LEN` bytes, stored verbatim, no duplicates. |
| Bound        | `>= 0` or absent     | Absent is a fact ("not stated"); negative is not one.                          |
| Order        | as served            | Re-sorting would rewrite the observation.                                      |
| Second write | replaces             | An asset the anchor stopped listing must not linger from the last observation. |

**The writer path is a third call.** `attest_receive` on the attester relays to
`put_receive`, with its own cooldown (`LastReceive`) for the reason `LastMeta`
has one. `attest` and `attest_meta` keep the signatures the deployed client
calls. The cost is a third transaction per sweep for each domain that has a
receive list.

**Rolling it out.** A contract deployed before this has no such method, and a
call to one answers `Error(WasmVm, MissingValue)`, which is a different shape
from a contract error. The clients treat it as "not deployed yet", not as a
failure:

- `AnchorAttester.attestReceive` returns an error with `methodMissing` set. This
  also covers an upgraded attester relaying to a registry that has no
  `put_receive` yet.
- `pnpm attest` still writes the bitmaps and the metadata, skips the limits for
  the rest of the run, and prints one warning (a `::warning::` annotation under
  GitHub Actions). The run does not fail.
- `AnchorRegistry.getReceive` returns `null`, the same answer it gives for a
  domain with no receive list.

Upgrade the registry first and the attester second, so there is never an
attester relaying to a method that does not exist. Nothing stored has to be
migrated: a domain simply has no receive list until its next attestation.

## Storage layout

```
Instance:  Admin, Attester, Domains
Persistent: Anchor(String) -> AnchorRecord      # unchanged
            Meta(String)   -> AnchorMeta        # new
              { domain: String,
                receive_assets: Vec<String>,     # observed
                country: Option<String>,         # declared, alpha-2
                attested_ledger: u32,
                attester: Address }
            Receive(String) -> ReceiveList      # added with #669
              { domain: String,
                assets: Vec<ReceiveAsset>,       # observed, in the order served
                  # { code: String,
                  #   min_amount: Option<i128>,  # scaled by 10^7; None = not recorded
                  #   max_amount: Option<i128> }
                attested_ledger: u32,
                attester: Address }
```

Events: `put_meta` publishes `meta_attested` (`Attested` keeps its shape), so an
indexer can follow either half without polling. `put_receive` publishes
`receive_attested` in the same way, and `bump(domain)` extends the receive list
along with the other two entries. A metadata write extends the
metadata entry and the contract instance, the way `put_anchor` extends the record
it wrote, and `bump(domain)` extends both entries a domain has so the record
cannot outlive its own metadata — or the other way round. Neither read extends
anything, which is also what `get_anchor` does.

## TypeScript decoding

`@corridor/registry` decodes the struct into the same `AnchorAttestation` shape it
already returns, as optional fields:

```ts
interface AnchorAttestation {
  // …unchanged fields…
  readonly receiveAssets?: readonly string[]; // present only if observed
  readonly country?: string; // present only if declared
}
```

Absent rather than empty is the point, and it mirrors `NotFound` on chain:
`getAnchor(domain)` stays one contract call by default, and
`getAnchor(domain, { meta: true })` adds a `get_meta` read and merges it only when
the domain has metadata. `getMeta(domain)` returns `null` for a domain with no
metadata — it does not throw, because for a record written before this existed
that is the expected case, not an error. Any other simulation failure rethrows.

On the write side, `AnchorAttester.attestMeta(result)` takes the same
`ProbeResult` `attest()` takes and submits only its `receiveAssets` and
`country`, encoding `Vec<String>` element-wise as `scvString` and an absent
country as `scvVoid` — that is what Soroban reads as `Option::None`, and the
empty string would mean something else entirely. It refuses locally when the
probe never ran `sep31_info`: a missing observation must not become an empty list
on chain, which is the one thing this design says twice.

`receivesAsset(domain, code)` answers the lane question straight from the
contract rather than filtering `get_meta` in the caller, and the reader exposes
the contract's error numbers as `RegistryContractError` with `contractErrorCode`
to pull one out of a simulation failure, so "this domain has no metadata" is a
comparison against `NotFound` rather than a match against English wording.

The receive limits (decision 6) follow the same pattern. `ProbeResult.receiveLimits`
is the list as `{ code, minAmount?, maxAmount? }`, with amounts as decimal strings
and never JS numbers, present exactly when `receiveAssets` is.
`AnchorAttester.attestReceive(result)` scales each bound to an `i128` and sends an
absent one as `scvVoid`. It refuses locally when there is no observation to send,
and when a bound is not an amount the contract would take.
`AnchorRegistry.getReceive(domain)` returns the list with amounts back in decimal
and an unrecorded bound left out of the object altogether, or `null` when the
registry holds no list; `receiveLimits(domain, code)` asks the contract about one
code.

One string of bytes holds the two languages to the same encoding.
`tests/attester-receive.test.ts` asserts the client sends it,
`decodes_the_receive_list_the_typescript_client_sends` in the attester crate
decodes it into the contract's type and relays it, and
`tests/registry-receive.test.ts` reads it back.

## Follow-ups, not decided here

- A country index (`domains_by_country`) so "which anchors serve Kenya" is one
  read instead of a scan of `domains()`. It needs its own write path and its own
  bounds, and a scan over a registry capped at `MAX_DOMAINS` is honest enough for
  now.
- Withdraw-asset lists for SEP-6/SEP-24, once a query needs them.
- Recording _when_ a declared country was last seen in a given form, so a change
  of declared jurisdiction is visible as a change rather than as a newer value.
