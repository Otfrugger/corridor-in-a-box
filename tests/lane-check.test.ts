import { describe, expect, it, vi } from "vitest";
import type { Sep10Signer } from "@corridor/adapter-kit";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { checkLane } from "@corridor/router";

const PASSPHRASE = "Test SDF Network ; September 2015";
const JWT = "header.eyJzdWIiOiJHQlVTSU5FU1MifQ.signature";

function corridor(webAuth?: string): Corridor {
  const parsed = parseCorridor({
    id: "lane-test",
    source: { name: "Sender", asset: "USDC", endpoints: { home_domain: "source.example" } },
    dest: {
      name: "Receiving Anchor",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "receiver.example",
        ...(webAuth ? { web_auth: webAuth } : {}),
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error.message}`);
  return parsed.value;
}

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function challenge(): Response {
  return response({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE });
}

function signer(account = "GBUSINESS"): Sep10Signer {
  return {
    account,
    signChallenge: vi.fn(async () => "SIGNED_CHALLENGE_XDR"),
  };
}

const WEB_AUTH = "https://receiver.example/sep10/auth";

describe("checkLane", () => {
  it("reports open when the stub anchor accepts the business signature", async () => {
    const business = signer();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ token: JWT }));

    const result = await checkLane(corridor(WEB_AUTH), { signer: business, fetchImpl });

    expect(result).toMatchObject({
      lane: "lane-test",
      receiver: "Receiving Anchor",
      homeDomain: "receiver.example",
      status: "open",
    });
    expect(result.detail).toContain("GBUSINESS");
    // The business signs its own challenge; the anchor's challenge reached it intact.
    expect(business.signChallenge).toHaveBeenCalledWith("CHALLENGE_XDR", PASSPHRASE);
    const challengeUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(challengeUrl).toContain(`account=${encodeURIComponent("GBUSINESS")}`);
    expect(challengeUrl).toContain("home_domain=receiver.example");
  });

  it("never puts the JWT in the result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ token: JWT }));

    const result = await checkLane(corridor(WEB_AUTH), { signer: signer(), fetchImpl });

    expect(result.detail).not.toContain(JWT);
    expect(JSON.stringify(result)).not.toContain(JWT);
  });

  it("reports closed when the stub anchor refuses the signed challenge", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ error: "account not onboarded" }, 403));

    const result = await checkLane(corridor(WEB_AUTH), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.detail).toContain("HTTP 403");
  });

  it("reports closed when the challenge request itself is refused", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ error: "unauthorized" }, 401));

    const result = await checkLane(corridor(WEB_AUTH), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.detail).toContain("HTTP 401");
  });

  it("reports unknown on an anchor server error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ error: "boom" }, 500));

    const result = await checkLane(corridor(WEB_AUTH), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("could not be checked");
  });

  it("reports unknown — not closed — when the anchor answers 400", async () => {
    // 400 can mean our own malformed challenge; it is not an onboarding refusal.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ error: "invalid transaction" }, 400));

    const result = await checkLane(corridor(WEB_AUTH), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
  });

  it("reports unknown when the anchor cannot be reached", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkLane(corridor(WEB_AUTH), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
  });

  it("reports unknown when the corridor declares no SEP-10 endpoint", async () => {
    const fetchImpl = vi.fn();

    const result = await checkLane(corridor(), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("no SEP-10 web_auth endpoint");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
