import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The gate in front of every route that proxies to CORRIDOR_SERVICE_URL: a
 * public endpoint must not lend out the server's service API key, so the caller
 * has to present CORRIDOR_WEB_API_KEY. Returns the refusal, or null to proceed.
 */
export function refuseUnauthorizedProxy(req: Request): NextResponse | null {
  const required = process.env.CORRIDOR_WEB_API_KEY;
  if (!required) {
    // Fail closed. Proxying to a real engine without a gate in front of it is
    // never the behaviour we want to fall back into by omission.
    return NextResponse.json(
      {
        error: "proxy_misconfigured",
        message: "CORRIDOR_SERVICE_URL is set but CORRIDOR_WEB_API_KEY is not",
      },
      { status: 503 },
    );
  }
  const presented = req.headers.get("authorization");
  if (!presented || !constantTimeEqual(presented, `Bearer ${required}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Headers for a request to the service, with its API key when one is configured. */
export function serviceHeaders(): Record<string, string> {
  const apiKey = process.env.CORRIDOR_SERVICE_API_KEY;
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
