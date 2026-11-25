// The send app's server-side proxy to @corridor/service.
//
// The browser never holds the service API key. It calls the web app's own
// routes under /api/send, and those routes call the service with the key read
// from the server's environment. This module is the whole of that exchange.
//
// What the browser controls is only the payment body and the run key in the
// URL. It cannot choose the service URL, the path or any header, and nothing
// from the service's error bodies beyond a short allow-list is passed back.
//
// The routes take no credentials from the caller, so they are gated instead:
//
//   fail closed   until SEND_APP_CORRIDORS names the corridors to serve, both
//                 routes answer 503 and the service is never called
//   allow-list    a payment for any other corridor is refused with 403, so only
//                 the testnet lanes the operator lists can be reached
//   rate limit    each client gets a fixed number of calls per minute
//
// Pure and self-contained on purpose (no imports from the rest of web/, no
// Next.js types), so the behaviour is unit-tested from the repo's root suite.
// Only server route handlers import it. A client component must not: see
// tests/web-send-proxy.test.ts.

/** Where the proxy sends calls. Both come from the server's environment. */
export interface SendProxyConfig {
  serviceUrl?: string;
  apiKey?: string;
  /** The corridor ids the proxy will serve. Empty or unset refuses everything. */
  allowedCorridors?: readonly string[];
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** What a route handler turns into an HTTP response. */
export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * The environment variables the proxy reads. They are deliberately not the ones
 * the showcase's /api/payments route uses, so enabling the send app does not
 * also lend its credentials to that route, and the key can be a separate,
 * testnet-only one. None carries the NEXT_PUBLIC_ prefix, which is what would
 * put a value in the client bundle.
 */
export const SEND_PROXY_ENV = {
  url: "SEND_APP_SERVICE_URL",
  key: "SEND_APP_SERVICE_API_KEY",
  corridors: "SEND_APP_CORRIDORS",
} as const;

export function sendProxyConfigFromEnv(
  env: Record<string, string | undefined>,
): SendProxyConfig {
  return {
    serviceUrl: env[SEND_PROXY_ENV.url],
    apiKey: env[SEND_PROXY_ENV.key],
    allowedCorridors: (env[SEND_PROXY_ENV.corridors] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

/** A payment intent is well under 1 KiB; anything larger is not a real request. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST /payments answers only once the run has finished, which includes waiting
 * on the receiving anchor, so the wait is long. It still ends.
 */
export const SERVICE_TIMEOUT_MS = 5 * 60 * 1000;

/** Calls one client may make per window. A run is read back about every two seconds. */
export const SEND_LIMITS = {
  create: { max: 10, windowMs: 60_000 },
  read: { max: 120, windowMs: 60_000 },
} as const;

export interface RateLimiter {
  /** True when this client may make another call now. */
  allow(client: string): boolean;
}

/** Clients tracked at once. Beyond it the oldest are forgotten, which bounds memory. */
const MAX_TRACKED_CLIENTS = 10_000;

/**
 * A fixed-window limiter held in this process's memory. It is a guard against
 * a script hammering the routes, not a quota: each server instance counts on
 * its own and a restart resets it.
 */
export function createRateLimiter(
  opts: { max: number; windowMs: number },
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(client) {
      const t = now();
      const w = windows.get(client);
      if (!w || t - w.start >= opts.windowMs) {
        windows.delete(client);
        windows.set(client, { start: t, count: 1 });
        while (windows.size > MAX_TRACKED_CLIENTS) {
          windows.delete(windows.keys().next().value as string);
        }
        return true;
      }
      w.count += 1;
      return w.count <= opts.max;
    },
  };
}

/**
 * Who a request is from, for the limiter: the first address in x-forwarded-for,
 * which the hosting platform sets in front of this app. A request that skips the
 * platform could forge it, so this is no substitute for the corridor allow-list.
 */
export function clientOf(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

/** The same rule the service applies to an idempotency key. */
const RUN_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Fields of a service error body that may reach the browser. */
const ERROR_FIELDS = ["error", "field", "reason", "corridorId"] as const;

const unavailable: ProxyResult = { status: 503, body: { error: "send_unavailable" } };
const tooMany: ProxyResult = { status: 429, body: { error: "rate_limited" } };

/** Serving needs a service to call and a list of corridors it may be asked about. */
function configured(config: SendProxyConfig): boolean {
  return Boolean(config.serviceUrl) && (config.allowedCorridors?.length ?? 0) > 0;
}

function relay(status: number, text: string): ProxyResult {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { status: 502, body: { error: "bad_gateway" } };
  }
  if (status >= 200 && status < 300) return { status, body: parsed };
  // An error body is cut down to its code and the offending field. The service
  // puts upstream detail in `message`, and the sender has no use for it.
  const source =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const body: Record<string, unknown> = {};
  for (const field of ERROR_FIELDS) {
    if (source[field] !== undefined) body[field] = source[field];
  }
  return { status, body: Object.keys(body).length > 0 ? body : { error: "service_error" } };
}

async function callService(
  config: SendProxyConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<ProxyResult> {
  if (!config.serviceUrl) return unavailable;
  const doFetch = config.fetch ?? fetch;
  try {
    const res = await doFetch(`${config.serviceUrl.replace(/\/+$/, "")}${path}`, {
      method: init.method,
      // Built here, never copied from the incoming request.
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    return relay(res.status, await res.text());
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { status: 504, body: { error: "service_timeout" } };
    }
    return { status: 502, body: { error: "service_unreachable" } };
  }
}

/** POST /api/send/payments: forward a payment body to the service. */
export async function proxyCreatePayment(
  config: SendProxyConfig,
  rawBody: string,
  client = "unknown",
  limiter?: RateLimiter,
): Promise<ProxyResult> {
  if (!configured(config)) return unavailable;
  if (limiter && !limiter.allow(client)) return tooMany;
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return { status: 413, body: { error: "payload too large" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "invalid payment body" } };
  }
  const { corridorId } = parsed as { corridorId?: unknown };
  if (typeof corridorId !== "string" || !config.allowedCorridors?.includes(corridorId)) {
    return { status: 403, body: { error: "corridor_not_allowed" } };
  }
  // The service validates the other fields strictly; this forwards the body as is.
  return callService(config, "/payments", { method: "POST", body: JSON.stringify(parsed) });
}

/** GET /api/send/payments/:key: read one run back from the service. */
export async function proxyGetPayment(
  config: SendProxyConfig,
  key: string,
  client = "unknown",
  limiter?: RateLimiter,
): Promise<ProxyResult> {
  if (!configured(config)) return unavailable;
  if (limiter && !limiter.allow(client)) return tooMany;
  if (!RUN_KEY_PATTERN.test(key)) {
    return { status: 400, body: { error: "invalid payment key" } };
  }
  return callService(config, `/payments/${encodeURIComponent(key)}`, { method: "GET" });
}
