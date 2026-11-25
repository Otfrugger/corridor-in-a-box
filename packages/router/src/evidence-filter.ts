// filterByEvidence — the planner step that drops anchors the registry cannot vouch for.
//
// A planner may only offer routes through anchors with a fresh attestation for
// the protocol the candidate would be reached over. This step applies the same
// rules as RegistryRouteResolver (via checkAttestation) to a list of candidates
// and, instead of throwing on the first refusal, reports why each dropped one
// was dropped. There is no allowlist here: a planner offering an anchor is a
// recommendation, and it never recommends one without evidence.

import {
  asAttestationSource,
  checkAttestation,
  type AttestationRefusal,
  type AttestationSourceLike,
} from "./registry-resolver";

/** An anchor a planner is considering, reached over a given protocol. */
export interface EvidenceCandidate {
  /** The anchor's home domain, as the registry keys it. */
  readonly domain: string;
  /** The protocol the route would use, e.g. "sep31", "sep6", "custom:<id>". */
  readonly protocol: string;
}

export interface EvidenceFilterDeps {
  /** Where attestations are read from. */
  readonly registry: AttestationSourceLike;
  /** How old an attestation may be and still count, in ledgers. Same default as RegistryRouteResolver. */
  readonly maxStalenessLedgers?: number;
}

export interface EvidenceFilterResult<C extends EvidenceCandidate> {
  /** Candidates with fresh evidence, in input order. */
  readonly kept: C[];
  /** Candidates without it, in input order, each with the reason. */
  readonly dropped: Array<{ readonly candidate: C; readonly reason: AttestationRefusal }>;
}

/**
 * Split candidates into those with a fresh attestation for their protocol and
 * those without. Never throws for a registry failure: an unreachable registry
 * drops the candidate with reason `registry unreachable`.
 */
export async function filterByEvidence<C extends EvidenceCandidate>(
  candidates: readonly C[],
  deps: EvidenceFilterDeps,
): Promise<EvidenceFilterResult<C>> {
  const registry = asAttestationSource(deps.registry);
  const checks = await Promise.all(
    candidates.map((c) =>
      checkAttestation(registry, c.domain, c.protocol, deps.maxStalenessLedgers),
    ),
  );
  const result: EvidenceFilterResult<C> = { kept: [], dropped: [] };
  checks.forEach((check, i) => {
    const candidate = candidates[i]!;
    if (check.ok) result.kept.push(candidate);
    else result.dropped.push({ candidate, reason: check.reason });
  });
  return result;
}
