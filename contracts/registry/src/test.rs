#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::storage::{Instance as _, Persistent as _},
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, Event as _, String, Vec,
};

/// Bit indices, mirroring SEP_NUMBERS / PROBE_NAMES. Spelled out here rather
/// than imported so a silent reordering in lib.rs fails these tests loudly.
const SEP1: u32 = 1 << 0;
const SEP6: u32 = 1 << 1;
const SEP10: u32 = 1 << 2;
const SEP12: u32 = 1 << 3;
const SEP31: u32 = 1 << 5;
const SEP38: u32 = 1 << 6;
const PROBE_TOML: u32 = 1 << 0;
const PROBE_SEP31_INFO: u32 = 1 << 4;
const PROBE_SEP6_INFO: u32 = 1 << 5;
const PROBE_SEP6_AUTH: u32 = 1 << 6;

struct Fixture {
    env: Env,
    client: RegistryClient<'static>,
    admin: Address,
    attester: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let id = env.register(Registry, (admin.clone(), attester.clone()));
    let client = RegistryClient::new(&env, &id);
    Fixture {
        env,
        client,
        admin,
        attester,
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn domain(env: &Env) -> String {
    String::from_str(env, "testanchor.stellar.org")
}

#[test]
fn stores_and_reads_back_an_attestation() {
    let f = setup();
    let d = domain(&f.env);
    f.client.put_anchor(
        &d,
        &(SEP1 | SEP10 | SEP12 | SEP31 | SEP38),
        &hash(&f.env, 0xab),
        &(PROBE_TOML | PROBE_SEP31_INFO),
        &(PROBE_TOML | PROBE_SEP31_INFO),
        &f.attester,
    );

    let r = f.client.get_anchor(&d);
    assert_eq!(r.domain, d);
    assert_eq!(r.toml_hash, hash(&f.env, 0xab));
    assert_eq!(r.attester, f.attester);
    assert_eq!(f.client.domains().len(), 1);
}

#[test]
fn decodes_the_sep_bitmap_so_callers_never_see_it() {
    let f = setup();
    let d = domain(&f.env);
    f.client.put_anchor(
        &d,
        &(SEP10 | SEP31 | SEP38),
        &hash(&f.env, 1),
        &0,
        &0,
        &f.attester,
    );

    let seps = f.client.seps_for(&d);
    assert_eq!(seps.len(), 3);
    assert_eq!(seps.get(0).unwrap(), 10);
    assert_eq!(seps.get(1).unwrap(), 31);
    assert_eq!(seps.get(2).unwrap(), 38);
}

#[test]
fn re_attesting_updates_in_place_without_duplicating_the_domain() {
    let f = setup();
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    f.client
        .put_anchor(&d, &(SEP31 | SEP38), &hash(&f.env, 2), &0, &0, &f.attester);

    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.get_anchor(&d).toml_hash, hash(&f.env, 2));
}

// --- the staleness contract ---------------------------------------------
// An attestation is never "wrong", only old. These two tests are the reason
// attested_ledger exists at all.

#[test]
fn records_the_ledger_it_was_attested_at() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert_eq!(f.client.attested_at(&d), 1_000);
}

#[test]
fn staleness_grows_with_the_ledger() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert_eq!(f.client.staleness(&d), 0);

    f.env.ledger().set_sequence_number(401_000);
    assert_eq!(f.client.staleness(&d), 400_000);
}

// --- validation: the registry does not store whatever it is handed ---------

#[test]
fn rejects_a_probe_claimed_passed_without_being_run() {
    let f = setup();
    let d = domain(&f.env);
    let res = f.client.try_put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_TOML,                      // ran only the toml probe
        &(PROBE_TOML | PROBE_SEP31_INFO), // but claims two passed
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::PassedExceedsRun)));
}

#[test]
fn rejects_bits_outside_the_defined_range() {
    let f = setup();
    let d = domain(&f.env);
    let undefined_sep_bit = 1u32 << 20;
    let res = f.client.try_put_anchor(
        &d,
        &undefined_sep_bit,
        &hash(&f.env, 1),
        &0,
        &0,
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::UnknownBit)));

    let undefined_probe_bit = 1u32 << 20;
    let res = f.client.try_put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &undefined_probe_bit,
        &0,
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::UnknownBit)));

    // Bit 7 is index 7 (the 8th bit), which is currently undefined for PROBE_NAMES.
    let bit_7 = 1u32 << 7;
    let res = f
        .client
        .try_put_anchor(&d, &SEP31, &hash(&f.env, 1), &bit_7, &0, &f.attester);
    assert_eq!(res, Err(Ok(Error::UnknownBit)));
}

#[test]
fn unknown_domain_is_not_found_rather_than_a_default() {
    let f = setup();
    let res = f
        .client
        .try_get_anchor(&String::from_str(&f.env, "nope.example"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// --- the question operators actually ask ----------------------------------

#[test]
fn serves_sep31_requires_both_advertised_and_probed() {
    let f = setup();
    let d = domain(&f.env);

    // Advertises SEP-31 but the probe was never run: not a yes.
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert!(!f.client.serves_sep31(&d));

    // Probe ran and failed: still not a yes.
    f.client.put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &0,
        &f.attester,
    );
    assert!(!f.client.serves_sep31(&d));

    // Advertised and probed green.
    f.client.put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
    assert!(f.client.serves_sep31(&d));

    // Probed green but no longer advertised: not a yes either.
    f.client.put_anchor(
        &d,
        &SEP10,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
    assert!(!f.client.serves_sep31(&d));

    // Generic serves helper agrees
    assert!(!f.client.serves(&d, &10));
    assert!(!f.client.serves(&d, &999));
}

#[test]
fn serves_sep6_requires_both_advertised_and_probed() {
    let f = setup();
    let d = domain(&f.env);

    // Advertises SEP-6 but the probe was never run: not a yes.
    f.client
        .put_anchor(&d, &SEP6, &hash(&f.env, 1), &0, &0, &f.attester);
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));

    // Probe ran and failed: still not a yes.
    f.client.put_anchor(
        &d,
        &SEP6,
        &hash(&f.env, 1),
        &PROBE_SEP6_INFO,
        &0,
        &f.attester,
    );
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));

    // Advertised and probed green (sep6_info).
    f.client.put_anchor(
        &d,
        &SEP6,
        &hash(&f.env, 1),
        &(PROBE_SEP6_INFO | PROBE_SEP6_AUTH),
        &PROBE_SEP6_INFO,
        &f.attester,
    );
    assert!(f.client.serves_sep6(&d));
    assert!(f.client.serves(&d, &6));

    // Probed green but no longer advertised: not a yes either.
    f.client.put_anchor(
        &d,
        &SEP1,
        &hash(&f.env, 1),
        &PROBE_SEP6_INFO,
        &PROBE_SEP6_INFO,
        &f.attester,
    );
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));
}

#[test]
fn old_layout_record_still_answers_serves_sep31_correctly() {
    let f = setup();
    let d = domain(&f.env);

    // Simulate an old-layout record written when PROBE_NAMES only had 5 bits (0..=4).
    // It advertises SEP-31 and passed PROBE_TOML and PROBE_SEP31_INFO, but bits 5 and 6 (sep6) are 0.
    let old_probes_run = PROBE_TOML | PROBE_SEP31_INFO;
    let old_probes_passed = PROBE_TOML | PROBE_SEP31_INFO;
    f.client.put_anchor(
        &d,
        &(SEP1 | SEP31),
        &hash(&f.env, 1),
        &old_probes_run,
        &old_probes_passed,
        &f.attester,
    );

    // serves_sep31 and serves(31) should answer true
    assert!(f.client.serves_sep31(&d));
    assert!(f.client.serves(&d, &31));

    // serves_sep6 must be false for old records until re-attested
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));
}

// --- admin ---------------------------------------------------------------

#[test]
fn admin_can_rotate_the_attester() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.client.set_attester(&next);
    assert_eq!(f.client.attester(), next);
    assert_eq!(f.client.admin(), f.admin);
}

/// Property-ish: every subset of the defined SEP bits round-trips through the
/// bitmap and back out of seps_for() with no loss and in ascending order.
#[test]
fn every_sep_combination_round_trips() {
    let f = setup();
    let d = domain(&f.env);
    let n = SEP_NUMBERS.len();

    for mask in 0u32..(1u32 << n) {
        f.client
            .put_anchor(&d, &mask, &hash(&f.env, 1), &0, &0, &f.attester);
        let got = f.client.seps_for(&d);

        let mut expected_len = 0u32;
        let mut previous = 0u32;
        for (i, sep) in SEP_NUMBERS.iter().enumerate() {
            if mask & (1u32 << i) != 0 {
                let actual = got.get(expected_len).unwrap();
                assert_eq!(
                    actual, *sep,
                    "mask {mask}: wrong sep at index {expected_len}"
                );
                assert!(actual > previous, "mask {mask}: not ascending");
                previous = actual;
                expected_len += 1;
            }
        }
        assert_eq!(got.len(), expected_len, "mask {mask}: wrong count");
    }
}

// ─── Storage lifetime ────────────────────────────────────────────────────────
//
// Soroban entries expire and are archived after their TTL. The unit-test
// environment does NOT archive: an entry past its `live_until` is still readable
// there, so reading a record back after advancing the ledger proves nothing.
// These tests assert the lifetime itself (`get_ttl`, ledgers left until expiry),
// advancing the ledger the way a quiet network would, and read the record back
// only as a sanity check on top.

/// The test environment's default minimum persistent TTL: what an entry that
/// nobody extended is given. Spelled out so a lifetime measured against it
/// cannot pass merely because the default changed.
const DEFAULT_TTL: u32 = 4_096;

fn advance(f: &Fixture, ledgers: u32) {
    f.env.ledger().with_mut(|l| l.sequence_number += ledgers);
}

fn put(f: &Fixture, d: &String) {
    f.client.put_anchor(
        d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
}

fn record_ttl(f: &Fixture, d: &String) -> u32 {
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Anchor(d.clone()))
    })
}

fn instance_ttl(f: &Fixture) -> u32 {
    f.env
        .as_contract(&f.client.address, || f.env.storage().instance().get_ttl())
}

#[test]
fn a_write_extends_the_record_and_the_instance() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn a_record_outlives_the_default_ttl_by_a_wide_margin() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    advance(&f, DEFAULT_TTL + 1);

    // Past the point a bare `set` would have expired, the record and the
    // instance still have the rest of their extension to run.
    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    // The list, the admin and the attester are all instance storage, and losing
    // it takes every read offline.
    assert_eq!(f.client.get_anchor(&d).domain, d);
    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.attester(), f.attester);
}

#[test]
fn a_bare_set_gets_only_the_default_ttl() {
    // What the contract used to do, measured: an entry written with a plain `set`
    // lives for the default TTL and no longer, which is the lifetime every
    // assertion above is an improvement on.
    let f = setup();
    let d = domain(&f.env);
    let record = AnchorRecord {
        domain: d.clone(),
        seps: SEP31,
        toml_hash: hash(&f.env, 1),
        probes_run: PROBE_SEP31_INFO,
        probes_passed: PROBE_SEP31_INFO,
        attested_ledger: f.env.ledger().sequence(),
        attester: f.attester.clone(),
    };
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Anchor(d.clone()), &record);
    });

    // The default counts the ledger the entry was created in, hence the one fewer.
    assert_eq!(record_ttl(&f, &d), DEFAULT_TTL - 1);
}

#[test]
fn bump_keeps_a_record_alive_without_re_attesting_it() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    put(&f, &d);
    let attested = f.client.attested_at(&d);

    // Nearly at the end of the lifetime a write bought, with nobody re-attesting.
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(record_ttl(&f, &d), 100);

    f.client.bump(&d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    // A thousand ledgers on, past the point the original extension would have
    // run out, it still has nearly the full lifetime left, and it is still exactly
    // as old as it was: a bump is not an attestation.
    advance(&f, 1_000);
    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - 1_000);
    assert_eq!(f.client.get_anchor(&d).domain, d);
    assert_eq!(f.client.attested_at(&d), attested);
    assert_eq!(f.client.staleness(&d), TTL_EXTEND_TO - 100 + 1_000);
}

#[test]
fn without_a_bump_the_lifetime_just_runs_down() {
    // What a bump saves a record from: nothing refreshes the lifetime by itself,
    // and reads do not extend it.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    advance(&f, TTL_EXTEND_TO - 1);
    let _ = f.client.get_anchor(&d);
    let _ = f.client.staleness(&d);

    assert_eq!(record_ttl(&f, &d), 1);
}

#[test]
fn bump_extends_the_instance_too() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.client.bump(&d);

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
    advance(&f, 1_000);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - 1_000);
    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn bump_needs_no_authorisation() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client.bump(&d);

    // `mock_all_auths` records every authorisation a call asked for; a
    // permissionless call asks for none.
    assert!(f.env.auths().is_empty());
}

#[test]
fn bumping_an_unknown_domain_is_not_found() {
    let f = setup();
    let d = String::from_str(&f.env, "never-attested.example");

    assert_eq!(f.client.try_bump(&d), Err(Ok(Error::NotFound)));
}

#[test]
fn a_write_inside_the_threshold_does_not_pay_for_another_extension() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // A day later the record still has far more than the threshold left, so a
    // re-attestation leaves its lifetime alone rather than re-buying it.
    advance(&f, LEDGERS_PER_DAY);
    put(&f, &d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - LEDGERS_PER_DAY);
}

#[test]
fn rotating_the_attester_extends_the_instance() {
    let f = setup();
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.client.set_attester(&Address::generate(&f.env));

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn emits_full_attested_event_payload() {
    let f = setup();
    f.env.ledger().set_sequence_number(4_242);
    let d = domain(&f.env);
    let seps = SEP1 | SEP10 | SEP12 | SEP31 | SEP38;
    let probes_run = PROBE_TOML | PROBE_SEP31_INFO;
    let probes_passed = PROBE_TOML;
    let toml_hash = hash(&f.env, 0xcd);

    f.client.put_anchor(
        &d,
        &seps,
        &toml_hash,
        &probes_run,
        &probes_passed,
        &f.attester,
    );

    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected = Attested {
        domain: d,
        seps,
        toml_hash,
        probes_run,
        probes_passed,
        attested_ledger: 4_242,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected);
}

// ─── Metadata: observed receive assets, declared country ─────────────────────
//
// The two halves of a domain's record are written and read separately, and the
// tests below are the ones that matter most for the upgrade: an anchor record
// that predates metadata must stay readable, untouched, and must not silently
// gain an empty list that a consumer would read as "receives nothing".

fn codes(env: &Env, list: &[&str]) -> Vec<String> {
    let mut v = Vec::new(env);
    for c in list {
        v.push_back(String::from_str(env, c));
    }
    v
}

fn country(env: &Env, code: &str) -> Option<String> {
    Some(String::from_str(env, code))
}

/// Thirty-three distinct codes: enough to sit on both sides of
/// `MAX_RECEIVE_ASSETS` without tripping the duplicate check first.
const ASSET_NAMES: [&str; 33] = [
    "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B0", "B1", "B2", "B3", "B4", "B5",
    "B6", "B7", "B8", "B9", "C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "D0", "D1",
    "D2",
];

/// An asset code exactly `MAX_ASSET_CODE_LEN` long, and one byte past it.
/// Written out rather than built so the length they assert is the length here.
const AT_LIMIT_CODE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const OVER_LIMIT_CODE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";

/// Attest the record, then write metadata on top of it — the order a sweep
/// submits in.
fn put_meta(f: &Fixture, d: &String, list: &[&str], c: Option<String>) {
    f.client.put_meta(d, &codes(&f.env, list), &c, &f.attester);
}

#[test]
fn stores_and_reads_back_metadata() {
    let f = setup();
    f.env.ledger().set_sequence_number(2_000);
    let d = domain(&f.env);
    put(&f, &d);

    put_meta(&f, &d, &["NGN", "KES"], country(&f.env, "NG"));

    let meta = f.client.get_meta(&d);
    assert_eq!(meta.domain, d);
    assert_eq!(meta.receive_assets, codes(&f.env, &["NGN", "KES"]));
    assert_eq!(meta.country, country(&f.env, "NG"));
    assert_eq!(meta.attested_ledger, 2_000);
    assert_eq!(meta.attester, f.attester);
}

#[test]
fn a_metadata_write_leaves_the_record_it_describes_alone() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    put(&f, &d);
    let before = f.client.get_anchor(&d);

    f.env.ledger().set_sequence_number(5_000);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    // Same bits, same toml hash, same attested ledger: metadata is a second key,
    // not a rewrite of the first. The two clocks stay distinguishable.
    let after = f.client.get_anchor(&d);
    assert_eq!(after, before);
    assert_eq!(after.attested_ledger, 1_000);
    assert_eq!(f.client.get_meta(&d).attested_ledger, 5_000);
    assert_eq!(f.client.staleness(&d), 4_000);
}

#[test]
fn re_attesting_the_record_does_not_erase_metadata() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN", "XOF"], country(&f.env, "NG"));

    put(&f, &d);

    assert_eq!(
        f.client.get_meta(&d).receive_assets,
        codes(&f.env, &["NGN", "XOF"])
    );
}

#[test]
fn a_record_with_no_metadata_reads_not_found_rather_than_empty() {
    // The pre-upgrade case: a record written by the previous version of this
    // contract. It must read exactly as it did before, and its absence of
    // metadata must not be reported as an anchor that receives nothing.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    let record = f.client.get_anchor(&d);
    assert_eq!(record.domain, d);
    assert!(f.client.serves_sep31(&d));

    assert_eq!(f.client.try_get_meta(&d), Err(Ok(Error::NotFound)));
    assert_eq!(
        f.client
            .try_receives_asset(&d, &String::from_str(&f.env, "NGN")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn metadata_about_an_unattested_domain_is_refused() {
    let f = setup();
    let d = String::from_str(&f.env, "never-attested.example");

    let res = f.client.try_put_meta(
        &d,
        &codes(&f.env, &["NGN"]),
        &country(&f.env, "NG"),
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn receives_asset_answers_from_the_observed_list() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN", "KES"], country(&f.env, "NG"));

    assert!(f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "NGN")));
    // Not a substring, not a prefix, not a currency of the declared country.
    assert!(!f.client.receives_asset(&d, &String::from_str(&f.env, "NG")));
    assert!(!f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "USDC")));
}

#[test]
fn an_empty_receive_list_is_a_finding_not_an_absence() {
    // testanchor.stellar.org: advertises SEP-31, `/info` lists nothing. That is
    // the fact the registry exists to record, so it has to be storable.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    put_meta(&f, &d, &[], None);

    let meta = f.client.get_meta(&d);
    assert_eq!(meta.receive_assets.len(), 0);
    assert_eq!(meta.country, None);
    assert!(!f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "NGN")));
}

#[test]
fn declares_no_country_without_inventing_one() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    put_meta(&f, &d, &["NGN"], None);
    assert_eq!(f.client.get_meta(&d).country, None);

    // A later sweep that does read a declaration replaces the absence.
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));
    assert_eq!(f.client.get_meta(&d).country, country(&f.env, "NG"));

    // And clearing a declaration that has gone away is expressible too.
    put_meta(&f, &d, &["NGN"], None);
    assert_eq!(f.client.get_meta(&d).country, None);
}

// --- bounds: the registry does not store whatever it is handed ---------------

#[test]
fn rejects_more_assets_than_the_bound_allows() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // Exactly at the bound is accepted — the limit is a ceiling, not an
    // off-by-one trap for an honest writer.
    f.client
        .put_meta(&d, &codes(&f.env, &ASSET_NAMES[..32]), &None, &f.attester);
    assert_eq!(
        f.client.get_meta(&d).receive_assets.len(),
        MAX_RECEIVE_ASSETS
    );

    // One past it is refused.
    let res = f
        .client
        .try_put_meta(&d, &codes(&f.env, &ASSET_NAMES), &None, &f.attester);
    assert_eq!(res, Err(Ok(Error::TooManyAssets)));
}

#[test]
fn rejects_an_asset_code_that_is_not_a_code() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(
        f.client
            .try_put_meta(&d, &codes(&f.env, &[""]), &None, &f.attester),
        Err(Ok(Error::InvalidAssetCode))
    );

    assert_eq!(
        f.client
            .try_put_meta(&d, &codes(&f.env, &[OVER_LIMIT_CODE]), &None, &f.attester),
        Err(Ok(Error::InvalidAssetCode))
    );

    // At the bound, accepted.
    f.client
        .put_meta(&d, &codes(&f.env, &[AT_LIMIT_CODE]), &None, &f.attester);
}

#[test]
fn rejects_the_same_asset_written_twice() {
    // len() is a count of assets an anchor receives; a list with a duplicate in
    // it would make that number a lie.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(
        f.client.try_put_meta(
            &d,
            &codes(&f.env, &["NGN", "KES", "ngn"]),
            &None,
            &f.attester
        ),
        Ok(Ok(()))
    );
    assert_eq!(
        f.client.try_put_meta(
            &d,
            &codes(&f.env, &["NGN", "KES", "NGN"]),
            &None,
            &f.attester
        ),
        Err(Ok(Error::DuplicateAsset))
    );
}

#[test]
fn rejects_a_country_that_is_not_alpha2() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    for bad in ["ng", "NGA", "N", "", "N1"] {
        let res = f.client.try_put_meta(
            &d,
            &codes(&f.env, &["NGN"]),
            &country(&f.env, bad),
            &f.attester,
        );
        assert_eq!(res, Err(Ok(Error::InvalidCountry)), "accepted {bad:?}");
    }

    f.client
        .put_meta(&d, &codes(&f.env, &["NGN"]), &None, &f.attester);
}

#[test]
fn emits_its_own_event_for_metadata() {
    let f = setup();
    f.env.ledger().set_sequence_number(7_777);
    let d = domain(&f.env);

    let seps = SEP31;
    let probes = PROBE_SEP31_INFO;
    let toml_hash = hash(&f.env, 1);
    f.client
        .put_anchor(&d, &seps, &toml_hash, &probes, &probes, &f.attester);

    // The unit-test host reports the events of the invocation that just ran, so
    // each write is read back on its own. What is pinned is that a metadata
    // write publishes `meta_attested` and nothing else — it neither rides on the
    // bitmap event nor replaces it, which is what lets an indexer follow a sweep
    // that writes the two halves in one ledger.
    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected_attested = Attested {
        domain: d.clone(),
        seps,
        toml_hash,
        probes_run: probes,
        probes_passed: probes,
        attested_ledger: 7_777,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected_attested);

    let list = codes(&f.env, &["NGN"]);
    let c = country(&f.env, "NG");
    f.client.put_meta(&d, &list, &c, &f.attester);

    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected_meta = MetaAttested {
        domain: d,
        receive_assets: list,
        country: c,
        attested_ledger: 7_777,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected_meta);
}

#[test]
fn a_metadata_write_extends_the_metadata_entry() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    let meta_ttl = f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Meta(d.clone()))
    });
    assert_eq!(meta_ttl, TTL_EXTEND_TO);
}

#[test]
fn bump_keeps_metadata_alive_alongside_the_record() {
    // Metadata expires on its own key. If bump only extended the record, a quiet
    // domain would answer get_anchor forever while get_meta archived away — a
    // record that slowly loses half its facts.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    advance(&f, TTL_EXTEND_TO - 100);
    f.client.bump(&d);

    let (record_ttl, meta_ttl) = f.env.as_contract(&f.client.address, || {
        (
            f.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Anchor(d.clone())),
            f.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Meta(d.clone())),
        )
    });
    assert_eq!(record_ttl, TTL_EXTEND_TO);
    assert_eq!(meta_ttl, TTL_EXTEND_TO);
}

// ─── receive list with amount bounds ─────────────────────────────────────────
//
// A third key beside the record and the metadata. The tests that matter most are
// the upgrade ones again: nothing stored before this existed may change shape or
// stop reading, and a domain with no receive list must not read as an anchor
// with no limits.

/// One whole unit of an asset on the registry's scale.
const ONE: i128 = 10_000_000;

fn entry(env: &Env, code: &str, min: Option<i128>, max: Option<i128>) -> ReceiveAsset {
    ReceiveAsset {
        code: String::from_str(env, code),
        min_amount: min,
        max_amount: max,
    }
}

fn receive(env: &Env, entries: &[(&str, Option<i128>, Option<i128>)]) -> Vec<ReceiveAsset> {
    let mut v = Vec::new(env);
    for (code, min, max) in entries {
        v.push_back(entry(env, code, *min, *max));
    }
    v
}

/// A list of `n` distinct codes with no bounds, for the count checks.
fn unbounded(env: &Env, names: &[&str]) -> Vec<ReceiveAsset> {
    let mut v = Vec::new(env);
    for code in names {
        v.push_back(entry(env, code, None, None));
    }
    v
}

#[test]
fn the_amount_scale_is_seven_decimal_places() {
    // Spelled out so that changing the scale fails here first: every bound
    // already on chain was written on this one.
    assert_eq!(AMOUNT_DECIMALS, 7);
    assert_eq!(ONE, 10i128.pow(AMOUNT_DECIMALS));
}

#[test]
fn stores_and_reads_back_a_receive_list() {
    let f = setup();
    f.env.ledger().set_sequence_number(3_000);
    let d = domain(&f.env);
    put(&f, &d);

    let sent = receive(
        &f.env,
        &[
            ("NGN", Some(1_000 * ONE), Some(5_000_000 * ONE)),
            ("USDC", Some(ONE / 10), Some(10_000 * ONE)),
        ],
    );
    f.client.put_receive(&d, &sent, &f.attester);

    let got = f.client.get_receive(&d);
    assert_eq!(got.domain, d);
    assert_eq!(got.assets, sent);
    assert_eq!(got.attested_ledger, 3_000);
    assert_eq!(got.attester, f.attester);
    // 0.1 USDC is one million stroops, not zero and not one.
    assert_eq!(got.assets.get_unchecked(1).min_amount, Some(1_000_000));
}

#[test]
fn a_receive_list_write_leaves_the_record_and_the_metadata_alone() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    put(&f, &d);
    f.env.ledger().set_sequence_number(2_000);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));
    let record = f.client.get_anchor(&d);
    let meta = f.client.get_meta(&d);

    f.env.ledger().set_sequence_number(5_000);
    f.client.put_receive(
        &d,
        &receive(&f.env, &[("NGN", Some(ONE), None)]),
        &f.attester,
    );

    // Three keys, three clocks. Writing the third moved neither of the others.
    assert_eq!(f.client.get_anchor(&d), record);
    assert_eq!(f.client.get_meta(&d), meta);
    assert_eq!(f.client.get_anchor(&d).attested_ledger, 1_000);
    assert_eq!(f.client.get_meta(&d).attested_ledger, 2_000);
    assert_eq!(f.client.get_receive(&d).attested_ledger, 5_000);
}

#[test]
fn rewriting_the_record_or_the_metadata_does_not_erase_the_receive_list() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    let sent = receive(&f.env, &[("NGN", Some(ONE), Some(9 * ONE))]);
    f.client.put_receive(&d, &sent, &f.attester);

    put(&f, &d);
    put_meta(&f, &d, &["NGN", "XOF"], country(&f.env, "NG"));

    assert_eq!(f.client.get_receive(&d).assets, sent);
}

#[test]
fn a_domain_with_no_receive_list_reads_not_found_rather_than_empty() {
    // The pre-upgrade case: a record and metadata written before the receive
    // list existed. Both must read exactly as before, and the missing list must
    // not be reported as "receives nothing" or as "no limits".
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    assert!(f.client.serves_sep31(&d));
    assert_eq!(
        f.client.get_meta(&d).receive_assets,
        codes(&f.env, &["NGN"])
    );
    assert!(f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "NGN")));

    assert_eq!(f.client.try_get_receive(&d), Err(Ok(Error::NotFound)));
    assert_eq!(
        f.client
            .try_receive_limits(&d, &String::from_str(&f.env, "NGN")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn a_receive_list_about_an_unattested_domain_is_refused() {
    let f = setup();
    let d = String::from_str(&f.env, "never-attested.example");

    let res = f.client.try_put_receive(
        &d,
        &receive(&f.env, &[("NGN", Some(ONE), None)]),
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
    assert_eq!(f.client.try_get_receive(&d), Err(Ok(Error::NotFound)));
}

#[test]
fn receive_limits_keeps_its_three_answers_apart() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    let ngn = String::from_str(&f.env, "NGN");

    // 1. Nobody has written a list: not an answer about NGN at all.
    assert_eq!(
        f.client.try_receive_limits(&d, &ngn),
        Err(Ok(Error::NotFound))
    );

    f.client.put_receive(
        &d,
        &receive(
            &f.env,
            &[
                ("NGN", Some(1_000 * ONE), Some(50_000 * ONE)),
                ("KES", None, None),
            ],
        ),
        &f.attester,
    );

    // 2. A list was written and holds the code: its entry.
    assert_eq!(
        f.client.receive_limits(&d, &ngn),
        Some(entry(&f.env, "NGN", Some(1_000 * ONE), Some(50_000 * ONE)))
    );
    // 3. A list was written and does not hold the code. Not a prefix, not a
    //    substring, not a different case.
    for other in ["NG", "NGNT", "ngn", "USDC"] {
        assert_eq!(
            f.client
                .receive_limits(&d, &String::from_str(&f.env, other)),
            None,
            "matched {other:?}"
        );
    }
}

#[test]
fn a_bound_the_anchor_did_not_state_is_none_and_not_zero() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client.put_receive(
        &d,
        &receive(
            &f.env,
            &[
                ("KES", None, None),
                ("NGN", Some(0), None),
                ("XOF", None, Some(7 * ONE)),
            ],
        ),
        &f.attester,
    );

    let kes = f
        .client
        .receive_limits(&d, &String::from_str(&f.env, "KES"))
        .unwrap();
    assert_eq!((kes.min_amount, kes.max_amount), (None, None));
    // A stated minimum of zero is a statement. It reads back as zero.
    let ngn = f
        .client
        .receive_limits(&d, &String::from_str(&f.env, "NGN"))
        .unwrap();
    assert_eq!((ngn.min_amount, ngn.max_amount), (Some(0), None));
    let xof = f
        .client
        .receive_limits(&d, &String::from_str(&f.env, "XOF"))
        .unwrap();
    assert_eq!((xof.min_amount, xof.max_amount), (None, Some(7 * ONE)));
}

#[test]
fn an_empty_receive_list_is_a_finding_too() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client
        .put_receive(&d, &Vec::<ReceiveAsset>::new(&f.env), &f.attester);

    assert_eq!(f.client.get_receive(&d).assets.len(), 0);
    // Asked, and it lists nothing: `None`, where a domain nobody asked is
    // `NotFound`.
    assert_eq!(
        f.client
            .receive_limits(&d, &String::from_str(&f.env, "NGN")),
        None
    );
}

#[test]
fn keeps_the_order_the_endpoint_returned() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    let sent = unbounded(&f.env, &["ZAR", "AAA", "NGN"]);
    f.client.put_receive(&d, &sent, &f.attester);

    assert_eq!(f.client.get_receive(&d).assets, sent);
}

#[test]
fn a_replaced_receive_list_is_the_new_one_whole() {
    // A second write is a replacement, not a merge: an asset the anchor stopped
    // listing must not linger from the last observation.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    f.client.put_receive(
        &d,
        &receive(&f.env, &[("NGN", Some(ONE), None), ("KES", None, None)]),
        &f.attester,
    );

    let second = receive(&f.env, &[("NGN", Some(2 * ONE), Some(3 * ONE))]);
    f.client.put_receive(&d, &second, &f.attester);

    assert_eq!(f.client.get_receive(&d).assets, second);
    assert_eq!(
        f.client
            .receive_limits(&d, &String::from_str(&f.env, "KES")),
        None
    );
}

#[test]
fn stores_a_minimum_above_the_maximum_as_it_was_observed() {
    // Not refused and not swapped. A reader comparing an amount against the
    // pair finds that nothing fits, which is what such an endpoint offers.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client.put_receive(
        &d,
        &receive(&f.env, &[("NGN", Some(100 * ONE), Some(10 * ONE))]),
        &f.attester,
    );

    let ngn = f
        .client
        .receive_limits(&d, &String::from_str(&f.env, "NGN"))
        .unwrap();
    assert_eq!(ngn.min_amount, Some(100 * ONE));
    assert_eq!(ngn.max_amount, Some(10 * ONE));
}

#[test]
fn rejects_a_negative_bound() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    for (min, max) in [
        (Some(-1), None),
        (None, Some(-1)),
        (Some(ONE), Some(-ONE)),
        (Some(i128::MIN), Some(ONE)),
    ] {
        let res = f
            .client
            .try_put_receive(&d, &receive(&f.env, &[("NGN", min, max)]), &f.attester);
        assert_eq!(
            res,
            Err(Ok(Error::InvalidAmount)),
            "accepted {min:?}..{max:?}"
        );
    }
    // A bad entry anywhere in the list refuses the whole write.
    let res = f.client.try_put_receive(
        &d,
        &receive(&f.env, &[("KES", Some(ONE), None), ("NGN", Some(-1), None)]),
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
    assert_eq!(f.client.try_get_receive(&d), Err(Ok(Error::NotFound)));

    // Zero and the largest amount there is are both fine.
    f.client.put_receive(
        &d,
        &receive(&f.env, &[("NGN", Some(0), Some(i128::MAX))]),
        &f.attester,
    );
    assert_eq!(
        f.client.get_receive(&d).assets,
        receive(&f.env, &[("NGN", Some(0), Some(i128::MAX))])
    );
}

#[test]
fn rejects_more_receive_entries_than_the_bound_allows() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client
        .put_receive(&d, &unbounded(&f.env, &ASSET_NAMES[..32]), &f.attester);
    assert_eq!(f.client.get_receive(&d).assets.len(), MAX_RECEIVE_ASSETS);

    let res = f
        .client
        .try_put_receive(&d, &unbounded(&f.env, &ASSET_NAMES), &f.attester);
    assert_eq!(res, Err(Ok(Error::TooManyAssets)));
    // The refused write changed nothing.
    assert_eq!(f.client.get_receive(&d).assets.len(), MAX_RECEIVE_ASSETS);
}

#[test]
fn rejects_a_receive_entry_whose_code_is_not_a_code() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    for bad in ["", OVER_LIMIT_CODE] {
        let res = f
            .client
            .try_put_receive(&d, &unbounded(&f.env, &["NGN", bad]), &f.attester);
        assert_eq!(res, Err(Ok(Error::InvalidAssetCode)), "accepted {bad:?}");
    }
    f.client
        .put_receive(&d, &unbounded(&f.env, &[AT_LIMIT_CODE]), &f.attester);
    assert_eq!(f.client.get_receive(&d).assets.len(), 1);
}

#[test]
fn rejects_the_same_code_listed_twice_in_a_receive_list() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // Different bounds do not make it a different asset: two entries for one
    // code would give `receive_limits` two answers.
    let res = f.client.try_put_receive(
        &d,
        &receive(
            &f.env,
            &[
                ("NGN", Some(ONE), None),
                ("KES", None, None),
                ("NGN", Some(2 * ONE), None),
            ],
        ),
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::DuplicateAsset)));
}

#[test]
fn a_receive_list_needs_the_attesters_authorisation() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    let sent = receive(&f.env, &[("NGN", Some(ONE), None)]);

    // Stop accepting every signature. Nothing has signed from here on, so the
    // only way this write gets through is if `put_receive` forgot to ask.
    f.env.set_auths(&[]);
    let res = f.client.try_put_receive(&d, &sent, &f.attester);
    assert!(
        matches!(res, Err(Err(_))),
        "an unauthorised write must abort, got {res:?}"
    );
    assert_eq!(f.client.try_get_receive(&d), Err(Ok(Error::NotFound)));
}

#[test]
fn emits_its_own_event_for_a_receive_list() {
    let f = setup();
    f.env.ledger().set_sequence_number(8_888);
    let d = domain(&f.env);
    put(&f, &d);

    let sent = receive(
        &f.env,
        &[("NGN", Some(ONE), Some(5 * ONE)), ("KES", None, None)],
    );
    f.client.put_receive(&d, &sent, &f.attester);

    // One event for this write, and it is neither of the other two.
    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected = ReceiveAttested {
        domain: d,
        assets: sent,
        attested_ledger: 8_888,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected);
}

fn receive_ttl(f: &Fixture, d: &String) -> u32 {
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Receive(d.clone()))
    })
}

#[test]
fn a_receive_list_write_extends_its_own_entry() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    f.client
        .put_receive(&d, &unbounded(&f.env, &["NGN"]), &f.attester);

    assert_eq!(receive_ttl(&f, &d), TTL_EXTEND_TO);
}

#[test]
fn bump_keeps_the_receive_list_alive_alongside_the_record() {
    // The list expires on its own key, like the metadata. If bump skipped it, a
    // quiet domain would keep its record and lose its limits.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    f.client
        .put_receive(&d, &unbounded(&f.env, &["NGN"]), &f.attester);

    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(receive_ttl(&f, &d), 100);
    f.client.bump(&d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    assert_eq!(receive_ttl(&f, &d), TTL_EXTEND_TO);
}

#[test]
fn bump_still_works_for_a_domain_with_no_receive_list() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    advance(&f, TTL_EXTEND_TO - 100);

    f.client.bump(&d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    assert_eq!(f.client.try_get_receive(&d), Err(Ok(Error::NotFound)));
}

// ─── why the receive list is a new key and not a new field ───────────────────
//
// `DataKey` is append-only and so are the structs it points at. These two tests
// are the reason, held in place: the first shows what a new field would do to
// entries already stored, the second fails the day someone adds one to
// `AnchorMeta`.

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct ShapeAsStored {
    domain: String,
    attested_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct ShapeWithOneMoreField {
    domain: String,
    attested_ledger: u32,
    added_later: Option<u32>,
}

fn as_first_stored(env: &Env) -> ShapeAsStored {
    ShapeAsStored {
        domain: String::from_str(env, "testanchor.stellar.org"),
        attested_ledger: 1_000,
    }
}

#[test]
fn a_stored_struct_reads_back_in_the_shape_it_was_written_in() {
    use soroban_sdk::{IntoVal, TryFromVal, Val};

    let env = Env::default();
    let stored: Val = as_first_stored(&env).into_val(&env);

    assert_eq!(
        ShapeAsStored::try_from_val(&env, &stored).unwrap(),
        as_first_stored(&env)
    );
}

#[test]
#[should_panic(expected = "UnexpectedSize")]
fn a_stored_struct_cannot_gain_a_field() {
    use soroban_sdk::{IntoVal, TryFromVal, Val};

    let env = Env::default();
    let stored: Val = as_first_stored(&env).into_val(&env);

    // The same value, read as the same struct with one field added, and an
    // optional one at that. There is no default to fall back on: the host
    // refuses the decode outright, which inside a contract is a trap and not an
    // error a caller could handle. Every entry written before the change would
    // stop reading.
    let _ = ShapeWithOneMoreField::try_from_val(&env, &stored);
}

/// `AnchorMeta` exactly as the first metadata entries were stored.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct MetaAsFirstStored {
    domain: String,
    receive_assets: Vec<String>,
    country: Option<String>,
    attested_ledger: u32,
    attester: Address,
}

#[test]
fn metadata_stored_before_the_receive_list_existed_still_reads() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // Write the entry directly, in the shape it has had since it was added.
    let before = MetaAsFirstStored {
        domain: d.clone(),
        receive_assets: codes(&f.env, &["NGN", "KES"]),
        country: country(&f.env, "NG"),
        attested_ledger: 4_321,
        attester: f.attester.clone(),
    };
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Meta(d.clone()), &before);
    });

    let meta = f.client.get_meta(&d);
    assert_eq!(meta.receive_assets, codes(&f.env, &["NGN", "KES"]));
    assert_eq!(meta.country, country(&f.env, "NG"));
    assert_eq!(meta.attested_ledger, 4_321);
    assert_eq!(meta.attester, f.attester);
    assert!(f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "KES")));
}
