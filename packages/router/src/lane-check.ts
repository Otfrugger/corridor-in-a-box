// Lane check v1 — ask a receiving anchor whether it will let THIS business in.
//
// A receiving anchor only accepts senders it has onboarded, and many enforce
// that at SEP-10 login: the challenge is signed with our own key and the anchor
// decides whether to issue a JWT. That makes a real handshake the cheapest
// honest answer to "is this lane open to us?" — and the answer a fallback needs
// before it is worth trying (RFC 0004, docs/rfcs/0004-smart-router.md).
//
// Three answers, and the difference is the point:
//
//   open     the anchor issued a JWT — our key is accepted
//   closed   the anchor explicitly refused the credential (HTTP 401 / 403)
//   unknown  anything else: no web_auth endpoint, 5xx, timeout, malformed
//            response. A probe that could not ask is not evidence that the lane
//            is closed, so it never reports one.
//
// The JWT itself is discarded here. It is a credential for the anchor, it has
// no place in a routing decision, and it is never logged or returned.

import { Sep10Client, type Sep10Signer } from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";

/** What a SEP-10 lane check can conclude. */
export type LaneStatus =
  /** The anchor completed the handshake and issued a JWT for our account. */
  | "open"
  /** The anchor explicitly refused our credential (HTTP 401 or 403). */
  | "closed"
  /** The question could not be answered — reachability, timeout, server error. */
  | "unknown";

export interface LaneCheckOptions {
  /** The business's own SEP-10 signer; the account the anchor sees logging in. */
  readonly signer: Sep10Signer;
  /** Injectable transport, for tests and for an operator's own HTTP client. */
  readonly fetchImpl?: typeof fetch;
  /** Bound on each request to the anchor. Default 15s, as with the probe. */
  readonly timeoutMs?: number;
}

export interface LaneCheckResult {
  /** The corridor this check was run for. */
  readonly lane: string;
  /** The receiving anchor's manifest name. */
  readonly receiver: string;
  /** The receiving anchor's home domain, as the manifest declares it. */
  readonly homeDomain: string;
  readonly status: LaneStatus;
  /**
   * Why, in one PII-free line. Names the account and the HTTP status at most;
   * never the JWT and never a response body.
   */
  readonly detail: string;
}

// SEP-10 defines 401 for a missing credential and 403 for "this application may
// not authenticate". Both are the anchor refusing us, which is the closed
// signal. Every other status is an error we cannot attribute to an onboarding
// decision: 400 can mean our own malformed challenge, 404 a wrong endpoint, 5xx
// an anchor outage. Those stay unknown.
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

function webAuthOf(corridor: Corridor): string | undefined {
  const endpoints = corridor.dest.endpoints as Readonly<Record<string, unknown>>;
  const webAuth = endpoints.web_auth;
  return typeof webAuth === "string" && webAuth.length > 0 ? webAuth : undefined;
}

/**
 * Run a SEP-10 challenge/response against the corridor's receiving anchor with
 * the business's own signer and report whether the lane accepts it.
 *
 * Never throws and never returns the JWT: an unreachable anchor, a bad
 * response or a signing failure all come back as `unknown` with a detail line.
 * SEP-10 authenticates an account rather than a payment, so this moves no
 * money and can be run before a route is chosen.
 */
export async function checkLane(
  corridor: Corridor,
  opts: LaneCheckOptions,
): Promise<LaneCheckResult> {
  const homeDomain = corridor.dest.endpoints.home_domain;
  const base = {
    lane: corridor.id,
    receiver: corridor.dest.name,
    homeDomain,
  };

  const webAuth = webAuthOf(corridor);
  if (!webAuth) {
    return {
      ...base,
      status: "unknown",
      detail: `${corridor.dest.name} publishes no SEP-10 web_auth endpoint in this corridor — cannot tell whether it would accept us`,
    };
  }

  // The shared client reports every failure as ANCHOR_UNAVAILABLE and does not
  // expose the HTTP status, so the transport is observed as it passes through:
  // the statuses are what separate an explicit refusal from an outage.
  const statuses: number[] = [];
  const baseFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const observedFetch: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    statuses.push(res.status);
    return res;
  };

  const client = new Sep10Client(webAuth, homeDomain, opts.signer, observedFetch);
  const token = await client.token();

  if (token.ok && token.value) {
    // `token.value` is intentionally dropped: the JWT is not ours to keep here.
    return {
      ...base,
      status: "open",
      detail: `SEP-10 handshake completed — ${corridor.dest.name} accepted ${opts.signer.account}`,
    };
  }

  const refused = statuses.find((status) => REFUSAL_STATUSES.has(status));
  if (refused !== undefined) {
    return {
      ...base,
      status: "closed",
      detail: `${corridor.dest.name} refused SEP-10 for ${opts.signer.account} (HTTP ${refused})`,
    };
  }

  const why = token.ok ? "the client returned no token" : token.error.message;
  return {
    ...base,
    status: "unknown",
    detail: `${corridor.dest.name} could not be checked: ${why}`,
  };
}
