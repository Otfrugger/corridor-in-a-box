// @corridor/router — the open-core line drawn in code.
//
// The interface and a dumb default ship here, in the open repo. The REAL resolver
// — health-weighted, rate-aware, split-routing, fed by the anchor conformance
// dataset — is proprietary and injected at runtime. Anyone can run the open
// engine; only the operator supplies the routing intelligence.

import type { Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";

export interface RouteDecision {
  /** The receiving anchor chosen for this payment. */
  readonly receiving: AnchorAdapter;
  /** Reserved for split routing across multiple anchors (weights sum to 1). */
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
  /** How the route decision was reached: verified against on-chain evidence or assumed from manifest. */
  readonly trust: "attested" | "manifest";
}

export interface RouteResolver {
  resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision>;
}

export interface StaticRouteResolverOptions {
  readonly trustManifestWithoutAttestation?: boolean;
}

/**
 * Default resolver: use the single anchor the manifest declares. No intelligence.
 * Swap this out for the proprietary resolver by passing a different RouteResolver
 * to the engine — that is the entire open/closed boundary.
 */
export class StaticRouteResolver implements RouteResolver {
  constructor(
    private readonly adapterFor: (corridor: Corridor) => AnchorAdapter,
    options?: StaticRouteResolverOptions,
  ) {
    if (!options?.trustManifestWithoutAttestation) {
      throw new Error(
        "StaticRouteResolver requires explicit { trustManifestWithoutAttestation: true }. Use RegistryRouteResolver for verified routing.",
      );
    }
  }

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    return {
      receiving: this.adapterFor(corridor),
      trust: "manifest",
    };
  }
}

// The registry-backed resolver: the open half of the seam, in code.
// StaticRouteResolver above trusts the manifest; this one requires evidence.
export {
  RegistryRouteResolver,
  UnattestedAnchorError,
  type AttestationSource,
  type RegistryResolverOptions,
} from "./registry-resolver";
