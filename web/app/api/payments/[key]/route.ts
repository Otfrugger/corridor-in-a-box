import { NextResponse } from "next/server";
import { getEngineDemoPayment } from "@/lib/engine-demo";
import { refuseUnauthorizedProxy, serviceHeaders } from "@/lib/service-auth";

// GET /api/payments/:key — mirrors @corridor/service's GET /payments/:key, the
// status the payment timeline polls. Same two modes as POST /api/payments: the
// in-process demo engine by default, or a gated proxy to CORRIDOR_SERVICE_URL.

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!key || key.length > 128) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const serviceUrl = process.env.CORRIDOR_SERVICE_URL;
  if (serviceUrl) {
    const refused = refuseUnauthorizedProxy(req);
    if (refused) return refused;
    try {
      const res = await fetch(
        `${serviceUrl.replace(/\/$/, "")}/payments/${encodeURIComponent(key)}`,
        { headers: serviceHeaders(), cache: "no-store" },
      );
      const text = await res.text();
      return NextResponse.json(text ? JSON.parse(text) : {}, { status: res.status });
    } catch {
      return NextResponse.json(
        { error: "service_unreachable", message: "could not reach CORRIDOR_SERVICE_URL" },
        { status: 502 },
      );
    }
  }

  const status = await getEngineDemoPayment(key);
  if (!status) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(status, { status: 200 });
}
