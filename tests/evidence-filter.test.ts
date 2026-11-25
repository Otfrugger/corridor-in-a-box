// filterByEvidence is a planner step built on the same gate as
// RegistryRouteResolver, so the cases worth testing are the ones where it must
// DROP — and say why — rather than wave a candidate through.

import { describe, expect, it } from "vitest";
import {
  filterByEvidence,
  type AttestationSource,
  type AttestedProtocol,
  type LegacyAttestationSource,
} from "@corridor/router";

const WEEK = 120_960;

/** A registry answering from a table of { domain: { protocols, staleness } }. */
function registry(
  table: Record<string, { serves: readonly AttestedProtocol[]; staleness: number }>,
): AttestationSource {
  return {
    serves: async (domain, protocol) => table[domain]?.serves.includes(protocol) ?? false,
    staleness: async (domain) => table[domain]?.staleness ?? Number.MAX_SAFE_INTEGER,
    tomlHash: async () => "0".repeat(64),
  };
}

const down: AttestationSource = {
  serves: async () => {
    throw new Error("rpc timeout");
  },
  staleness: async () => {
    throw new Error("rpc timeout");
  },
  tomlHash: async () => {
    throw new Error("rpc timeout");
  },
};

describe("filterByEvidence", () => {
  it("keeps a candidate with a fresh attestation for its protocol", async () => {
    const fresh = { domain: "fresh.example", protocol: "sep31" };
    const r = await filterByEvidence([fresh], {
      registry: registry({ "fresh.example": { serves: ["sep31"], staleness: 10 } }),
    });
    expect(r).toEqual({ kept: [fresh], dropped: [] });
  });

  it("drops a stale attestation", async () => {
    const stale = { domain: "stale.example", protocol: "sep31" };
    const r = await filterByEvidence([stale], {
      registry: registry({ "stale.example": { serves: ["sep31"], staleness: WEEK + 1 } }),
    });
    expect(r).toEqual({
      kept: [],
      dropped: [{ candidate: stale, reason: "stale attestation" }],
    });
  });

  it("honours a custom freshness limit, inclusive at the boundary", async () => {
    const reg = registry({ "a.example": { serves: ["sep31"], staleness: 100 } });
    const c = { domain: "a.example", protocol: "sep31" };
    expect(
      (await filterByEvidence([c], { registry: reg, maxStalenessLedgers: 100 })).kept,
    ).toEqual([c]);
    expect(
      (await filterByEvidence([c], { registry: reg, maxStalenessLedgers: 99 })).dropped,
    ).toEqual([{ candidate: c, reason: "stale attestation" }]);
  });

  it("drops a domain with no attestation", async () => {
    const missing = { domain: "missing.example", protocol: "sep31" };
    const r = await filterByEvidence([missing], { registry: registry({}) });
    expect(r).toEqual({ kept: [], dropped: [{ candidate: missing, reason: "not attested" }] });
  });

  it("drops a domain the contract reports as NotFound as not attested, not unreachable", async () => {
    const notFound = async (): Promise<never> => {
      throw new Error("HostError: Error(Contract, #6)");
    };
    const missing = { domain: "missing.example", protocol: "sep31" };
    const r = await filterByEvidence([missing], {
      registry: { ...down, serves: notFound, staleness: notFound },
    });
    expect(r).toEqual({ kept: [], dropped: [{ candidate: missing, reason: "not attested" }] });
  });

  it("still treats other contract errors as registry unreachable", async () => {
    const otherError = async (): Promise<never> => {
      throw new Error("HostError: Error(Contract, #60)");
    };
    const c = { domain: "a.example", protocol: "sep31" };
    const r = await filterByEvidence([c], {
      registry: { ...down, serves: otherError, staleness: otherError },
    });
    expect(r.dropped).toEqual([{ candidate: c, reason: "registry unreachable" }]);
  });

  it("drops a candidate attested only for a different protocol", async () => {
    const sep6 = { domain: "a.example", protocol: "sep6" };
    const r = await filterByEvidence([sep6], {
      registry: registry({ "a.example": { serves: ["sep31"], staleness: 0 } }),
    });
    expect(r.dropped).toEqual([{ candidate: sep6, reason: "not attested" }]);
  });

  it("drops a bespoke protocol the registry cannot attest", async () => {
    const custom = { domain: "a.example", protocol: "custom:http-stub" };
    const r = await filterByEvidence([custom], {
      registry: registry({ "a.example": { serves: ["sep31", "sep6"], staleness: 0 } }),
    });
    expect(r.dropped).toEqual([{ candidate: custom, reason: "protocol not attestable" }]);
  });

  it("drops every candidate as 'registry unreachable' when the registry is down", async () => {
    const cs = [
      { domain: "a.example", protocol: "sep31" },
      { domain: "b.example", protocol: "sep6" },
    ];
    const r = await filterByEvidence(cs, { registry: down });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(
      cs.map((candidate) => ({ candidate, reason: "registry unreachable" })),
    );
  });

  it("treats a failing staleness lookup alone as unreachable, never as fresh", async () => {
    const c = { domain: "a.example", protocol: "sep31" };
    const r = await filterByEvidence([c], {
      registry: {
        ...registry({ "a.example": { serves: ["sep31"], staleness: 0 } }),
        staleness: down.staleness,
      },
    });
    expect(r.dropped).toEqual([{ candidate: c, reason: "registry unreachable" }]);
  });

  it("splits a mixed list, preserving order and extra candidate fields", async () => {
    const cs = [
      { domain: "fresh.example", protocol: "sep31", rank: 1 },
      { domain: "stale.example", protocol: "sep31", rank: 2 },
      { domain: "sep6.example", protocol: "sep6", rank: 3 },
      { domain: "missing.example", protocol: "sep31", rank: 4 },
    ];
    const r = await filterByEvidence(cs, {
      registry: registry({
        "fresh.example": { serves: ["sep31"], staleness: 0 },
        "stale.example": { serves: ["sep31"], staleness: WEEK + 1 },
        "sep6.example": { serves: ["sep6"], staleness: 5 },
      }),
    });
    expect(r.kept).toEqual([cs[0], cs[2]]);
    expect(r.dropped).toEqual([
      { candidate: cs[1], reason: "stale attestation" },
      { candidate: cs[3], reason: "not attested" },
    ]);
  });

  it("accepts a legacy SEP-31-only source and drops SEP-6 candidates it cannot speak for", async () => {
    const legacy: LegacyAttestationSource = {
      servesSep31: async () => true,
      staleness: async () => 0,
      tomlHash: async () => "0".repeat(64),
    };
    const sep31 = { domain: "a.example", protocol: "sep31" };
    const sep6 = { domain: "a.example", protocol: "sep6" };
    const r = await filterByEvidence([sep31, sep6], { registry: legacy });
    expect(r.kept).toEqual([sep31]);
    expect(r.dropped).toEqual([{ candidate: sep6, reason: "not attested" }]);
  });

  it("returns empty lists for no candidates without touching the registry", async () => {
    expect(await filterByEvidence([], { registry: down })).toEqual({ kept: [], dropped: [] });
  });
});
