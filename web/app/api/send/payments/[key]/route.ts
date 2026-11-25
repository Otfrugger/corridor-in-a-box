import { NextResponse } from "next/server";
import {
  SEND_LIMITS,
  clientOf,
  createRateLimiter,
  proxyGetPayment,
  sendProxyConfigFromEnv,
} from "@/lib/send-proxy";

const limiter = createRateLimiter(SEND_LIMITS.read);

// GET /api/send/payments/:key: read one run back from @corridor/service,
// with the API key attached on the server.
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const config = sendProxyConfigFromEnv(process.env);
  const result = await proxyGetPayment(config, key, clientOf(req.headers), limiter);
  return NextResponse.json(result.body, { status: result.status });
}
