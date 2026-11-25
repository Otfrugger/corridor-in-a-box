import { NextResponse } from "next/server";
import {
  SEND_LIMITS,
  clientOf,
  createRateLimiter,
  proxyCreatePayment,
  sendProxyConfigFromEnv,
} from "@/lib/send-proxy";

const limiter = createRateLimiter(SEND_LIMITS.create);

// POST /api/send/payments: the send app's call to @corridor/service.
// The service API key is read here, on the server, and never sent to the browser.
// Gated by SEND_APP_CORRIDORS and a per-client rate limit; see lib/send-proxy.ts.
export async function POST(req: Request) {
  const config = sendProxyConfigFromEnv(process.env);
  const result = await proxyCreatePayment(
    config,
    await req.text(),
    clientOf(req.headers),
    limiter,
  );
  return NextResponse.json(result.body, { status: result.status });
}
