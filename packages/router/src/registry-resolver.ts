// RegistryRouteResolver — refuse to route through an anchor nobody has checked.
//
// This is where the RouteResolver seam becomes code.
//
//   OPEN (here)         Does this anchor demonstrably work, and how recently was
//                       that established? Facts, read from the on-chain registry.
//   NOT INCLUDED        Which of several working anchors should this payment go
//                       through? Health scoring, rate weighting, split routing.
//                       Not part of this repo; a resolver like that could be
//                       supplied separately through the same interface.
//
// This resolver is a GATE, not a chooser: it answers yes/no on evidence and
// nothing more. That is deliberate — a gate is exactly the piece that has to be
// auditable, because it is what stands between an operator and settling into a
// lane that does not exist.
//
// It is also the engine-side counterpart to the dashboard fix. The dashboard
// stopped *displaying* unverified anchors as healthy; this stops the engine
// *settling* through them.
//
// The question it asks is "does this anchor demonstrably serve THE PROTOCOL
// THIS CORRIDOR DECLARES?". A `protocol: sep6` lane is checked against the
// SEP-6 probe. Asking every lane about SEP-31 instead would refuse every
// SEP-6 corridor, and the tempting way to make that error go away — adding the
// anchor to `allowUnattestedDomains` — is exactly the escape hatch this gate
// exists to prevent.

import { protocolOf, type Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";
import type { RouteDecision, RouteResolver } from "./index";

/**
 * The protocols the on-chain registry can answer "does this anchor serve it?"
 * for. A bespoke `custom:<id>` lane is deliberately absent: the registry
 * attests SEP-31 and SEP-6 receive-side behaviour, and nothing else.
 */
export type AttestedProtocol = "sep31" | "sep6";

/** The subset of @corridor/registry this resolver needs. Declared structurally
 *  so @corridor/router does not take a dependency on a Soroban SDK — an engine
 *  embedder who supplies their own attestation source should not have to.
 *
 *  `serves` is asked about the protocol the CORRIDOR declares, not the one the
 *  resolver would prefer. */
export interface AttestationSource {
  serves(domain: string, protocol: AttestedProtocol): Promise<boolean>;
  staleness(domain: string): Promise<number>;
  tomlHash(domain: string): Promise<string>;
}

/**
 * The older shape of an attestation source: it could only answer the SEP-31
 * question. Still accepted, so an embedder that already wired one up keeps
 * working without a flag day.
 */
export interface LegacyAttestationSource {
  servesSep31(domain: string): Promise<boolean>;
  staleness(domain: string): Promise<number>;
  tomlHash(domain: string): Promise<string>;
}

/** Either shape of attestation source. */
export type AttestationSourceLike = AttestationSource | LegacyAttestationSource;

/** True for the protocols the registry can actually attest. */
export function isAttestedProtocol(protocol: string): protocol is AttestedProtocol {
  return protocol === "sep31" || protocol === "sep6";
}

/** True when the source speaks the protocol-aware interface. */
function isProtocolAware(source: AttestationSourceLike): source is AttestationSource {
  return typeof (source as AttestationSource).serves === "function";
}

/**
 * Adapt an attestation source to the protocol-aware interface.
 *
 * A legacy source only knows about SEP-31, so it answers `false` for every
 * other protocol rather than guessing. "We do not know" must never resolve to
 * "proceed" — that is the entire job of this gate, and a source that cannot
 * speak for a protocol is not evidence that the anchor serves it.
 */
export function asAttestationSource(source: AttestationSourceLike): AttestationSource {
  if (isProtocolAware(source)) return source;
  return {
    serves: (domain, protocol) =>
      protocol === "sep31" ? source.servesSep31(domain) : Promise.resolve(false),
    staleness: (domain) => source.staleness(domain),
    tomlHash: (domain) => source.tomlHash(domain),
  };
}

export function isUnattestedDomainAllowed(
  domain: string,
  allowUnattestedDomains: readonly string[] = [],
): boolean {
  return allowUnattestedDomains.includes(domain);
}

export class UnattestedAnchorError extends Error {
  constructor(
    readonly domain: string,
    readonly reason: string,
    /** The protocol the corridor declared, when the refusal is about one. */
    readonly protocol?: string,
  ) {
    super(`refusing to route through ${domain}: ${reason}`);
    this.name = "UnattestedAnchorError";
  }
}

export interface RegistryResolverOptions {
  /** Where attestations are read from. */
  registry: AttestationSourceLike;
  /** Adapter to use once an anchor clears the gate. */
  adapterFor: (corridor: Corridor) => AnchorAdapter;
  /**
   * How old an attestation may be and still count as evidence, in ledgers.
   * Default ~1 week at 5s ledgers.
   *
   * There is no "no maximum" option on purpose. An attestation from six months
   * ago is not evidence about today, and an operator who forgets to bound
   * freshness rebuilds precisely the failure this component exists to prevent.
   */
  maxStalenessLedgers?: number;
  /**
   * Escape hatch for lanes with no attestation yet — e.g. a self-hosted
   * reference server on localhost, which no public attester can see.
   *
   * Named for what it does. Anything vaguer ("strict: false") invites being
   * switched on to make an error go away, and the error is the feature.
   */
  allowUnattestedDomains?: readonly string[];
}

const WEEK_OF_LEDGERS = 120_960;

/**
 * How a Soroban client surfaces the registry contract's `NotFound` (code 6),
 * the same match `contractErrorCode` in @corridor/registry makes. Matched
 * here rather than imported so this package stays free of the Soroban SDK.
 */
const CONTRACT_NOT_FOUND = /Error\(Contract, #6\)/;

/** How a protocol is written when a refusal names it. */
function protocolLabel(protocol: string): string {
  if (protocol === "sep31") return "SEP-31";
  if (protocol === "sep6") return "SEP-6";
  return protocol;
}

/** Why an attestation check refused a domain. */
export type AttestationRefusal =
  "protocol not attestable" | "registry unreachable" | "not attested" | "stale attestation";

/** The result of {@link checkAttestation}: either evidence, or the refusal and an operator-facing detail. */
export type AttestationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AttestationRefusal; readonly detail: string };

/**
 * Does the registry hold fresh evidence that `domain` serves `protocol`?
 *
 * The one place the gate's rules live, shared by RegistryRouteResolver and
 * filterByEvidence. It never throws: a registry that cannot be read is a
 * refusal (`registry unreachable`), because "we do not know" must never
 * resolve to "proceed".
 */
export async function checkAttestation(
  registry: AttestationSource,
  domain: string,
  protocol: string,
  maxStalenessLedgers: number = WEEK_OF_LEDGERS,
): Promise<AttestationCheck> {
  // A bespoke lane has no on-chain probe: the registry attests SEP-31 and
  // SEP-6 receive-side behaviour, and there is no evidence to gather about a
  // `custom:<id>` API. The gate refuses rather than treating the manifest's
  // own claim as proof, and the message says which protocol is the problem so
  // the operator knows whether to re-attest or to use the allowlist.
  if (!isAttestedProtocol(protocol)) {
    return {
      ok: false,
      reason: "protocol not attestable",
      detail:
        `protocol ${protocol} has no on-chain attestation probe — the registry can only ` +
        `attest SEP-31 and SEP-6 receive-side. Add ${domain} to allowUnattestedDomains ` +
        `if this lane is deliberately exempt.`,
    };
  }

  const notAttested: AttestationCheck = {
    ok: false,
    reason: "not attested",
    detail:
      `not attested as serving ${protocolLabel(protocol)} receive-side. Advertising ` +
      `${protocolLabel(protocol)} in a stellar.toml is not sufficient — the ` +
      `${protocolLabel(protocol)} probe must also pass.`,
  };

  let serves: boolean;
  let staleness: number;
  try {
    [serves, staleness] = await Promise.all([
      registry.serves(domain, protocol),
      registry.staleness(domain),
    ]);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // The registry contract answers NotFound for a domain it has never
    // attested. That is a healthy registry saying "no evidence", not an outage.
    if (CONTRACT_NOT_FOUND.test(message)) return notAttested;
    // Fail CLOSED. An unreachable registry means we do not know whether this
    // anchor works, and "we do not know" must never resolve to "proceed".
    return {
      ok: false,
      reason: "registry unreachable",
      detail: `registry lookup failed (${message})`,
    };
  }

  if (!serves) return notAttested;
  if (staleness > maxStalenessLedgers) {
    return {
      ok: false,
      reason: "stale attestation",
      detail:
        `last attested ${staleness} ledgers ago, older than the ${maxStalenessLedgers} ` +
        `ledger limit. Re-attest before routing value through it.`,
    };
  }
  return { ok: true };
}

export class RegistryRouteResolver implements RouteResolver {
  private readonly registry: AttestationSource;
  private readonly adapterFor: (corridor: Corridor) => AnchorAdapter;
  private readonly maxStaleness: number;
  private readonly allowed: readonly string[];

  constructor(opts: RegistryResolverOptions) {
    this.registry = asAttestationSource(opts.registry);
    this.adapterFor = opts.adapterFor;
    this.maxStaleness = opts.maxStalenessLedgers ?? WEEK_OF_LEDGERS;
    this.allowed = opts.allowUnattestedDomains ?? [];
  }

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const domain = corridor.dest.endpoints.home_domain;
    const protocol = protocolOf(corridor.dest);

    if (isUnattestedDomainAllowed(domain, this.allowed)) {
      return { receiving: this.adapterFor(corridor), trust: "attested" };
    }

    const check = await checkAttestation(this.registry, domain, protocol, this.maxStaleness);
    if (!check.ok) throw new UnattestedAnchorError(domain, check.detail, protocol);

    return { receiving: this.adapterFor(corridor), trust: "attested" };
  }
}
