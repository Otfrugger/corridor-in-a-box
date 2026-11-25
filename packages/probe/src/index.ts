// @corridor/probe — go and ask an anchor what it actually does.
//
// The registry stores two different kinds of claim and never conflates them:
//
//   seps           what the anchor's stellar.toml ADVERTISES
//   probesPassed   what actually WORKED when we called it
//
// Keeping them apart is the whole point. `testanchor.stellar.org` advertises
// SEP-31 and returns an empty receive list — a tool that reads the toml alone
// calls that lane runnable, which is exactly the mistake this project is
// correcting. So every probe here does real protocol work: SEP-10 signs a
// challenge and exchanges it for a JWT, SEP-38 asks for a firm quote and checks
// the expiry is in the future, SEP-31 confirms the receive list is non-empty.
//
// `fetchImpl` is injectable so the whole thing is testable without a network.

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { declaredCountry } from "./country";
import { receiveLimitsFrom, type ReceiveAssetLimits } from "./receive";
import { tomlHash as tomlHashText } from "./toml-hash";
import { isSafeUrl } from "./url-safety";

export { tomlHash } from "./toml-hash";
export { isSafeUrl } from "./url-safety";
export { isCanonicalDomain, MAX_DOMAIN_LEN } from "./domain";
export { declaredCountry, toAlpha2, toAlpha3 } from "./country";
export { renderSweepMarkdown, renderSweepJson, isUsableSep31OffRamp } from "./report";
export {
  ANCHOR_KINDS,
  isValidAnchorDomain,
  loadFleet,
  parseFleet,
  type AnchorEntry,
  type AnchorFleet,
  type AnchorKind,
} from "./fleet";

/** SEP numbers in registry bit order. Must match SEP_NUMBERS in contracts/registry. */
export const SEP_NUMBERS = [1, 6, 10, 12, 24, 31, 38] as const;
/** Probe names in registry bit order. Must match PROBE_NAMES in contracts/registry. */
export const PROBE_NAMES = [
  "toml_fetch",
  "sep10_auth",
  "sep38_quote",
  "sep12_status",
  "sep31_info",
  "sep6_info",
  "sep6_auth",
] as const;

/**
 * Descriptive User-Agent identifying the probe and linking to this repository,
 * sent on every outbound HTTP request.
 */
export const PROBE_USER_AGENT =
  "corridor-in-a-box-probe (+https://github.com/corridor-in-a-box/corridor-in-a-box)";

export type SepNumber = (typeof SEP_NUMBERS)[number];
export type ProbeName = (typeof PROBE_NAMES)[number];

export type TomlFailureReason = "dns" | "timeout" | `http_${number}` | "tls" | "parse";

export const sepBit = (sep: SepNumber): number => 1 << SEP_NUMBERS.indexOf(sep);
export const probeBit = (probe: ProbeName): number => 1 << PROBE_NAMES.indexOf(probe);

export function decodeSeps(mask: number): SepNumber[] {
  return SEP_NUMBERS.filter((_, i) => (mask & (1 << i)) !== 0);
}
export function decodeProbes(mask: number): ProbeName[] {
  return PROBE_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
}

export interface ProbeOutcome {
  readonly probe: ProbeName;
  readonly passed: boolean;
  /** Why it passed or failed, for a human reading the job log. */
  readonly detail: string;
}

export interface ProbeResult {
  readonly domain: string;
  /** Bitmap over SEP_NUMBERS — advertised in the toml. */
  readonly seps: number;
  /** Bitmap over PROBE_NAMES — attempted. */
  readonly probesRun: number;
  /** Bitmap over PROBE_NAMES — passed. Always a subset of probesRun. */
  readonly probesPassed: number;
  /** SHA-256 of the stellar.toml, hex. All zeroes if it could not be fetched. */
  readonly tomlHash: string;
  /** Per-probe detail, in the order probes were attempted. */
  readonly outcomes: readonly ProbeOutcome[];
  /** Short reason why toml_fetch failed, or undefined if it passed. */
  readonly tomlFailureReason?: TomlFailureReason;
  /** Receive assets accepted by the anchor if SEP-31 probe passed. */
  readonly sep31ReceiveAssets?: readonly string[];
  /** Receive assets accepted by the anchor if SEP-31 probe passed. Kept for backwards compatibility. */
  readonly receiveAssets?: readonly string[];
  /**
   * OBSERVED: the same receive list with the `min_amount` and `max_amount` the
   * `/info` response stated for each asset, in the order it listed them.
   *
   * Present exactly when `sep31ReceiveAssets` is, since both are read from the
   * one response. An entry with no `minAmount` or `maxAmount` means no usable
   * bound was stated for that asset, not a bound of zero or of infinity.
   */
  readonly receiveLimits?: readonly ReceiveAssetLimits[];
  /**
   * DECLARED, not verified: the ISO-3166-1 alpha-2 country the anchor gives in
   * its own `stellar.toml` under `[DOCUMENTATION] ORG_PHYSICAL_ADDRESS`.
   *
   * Absent when the toml declares no country in a form that maps to a code without
   * a judgement call. That is not "this anchor has no country" — it is "we could
   * not read one", and on chain the difference is `None` rather than a value.
   */
  readonly country?: string;
  /** Raw text of stellar.toml if successfully fetched. */
  readonly toml?: string;
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Keypair used for the SEP-10 handshake. A random throwaway by default —
   *  SEP-10 authenticates an account, and any account will do to prove the
   *  endpoint performs the handshake correctly. */
  keypair?: Keypair;
  now?: () => number;
  /** Custom User-Agent header string. Defaults to PROBE_USER_AGENT. */
  userAgent?: string;
}

const ZERO_HASH = "0".repeat(64);

/** Endpoint keys in a stellar.toml, and which SEP each one implies. */
export const TOML_ENDPOINTS: ReadonlyArray<{ key: string; sep: SepNumber }> = [
  { key: "TRANSFER_SERVER", sep: 6 },
  { key: "WEB_AUTH_ENDPOINT", sep: 10 },
  { key: "KYC_SERVER", sep: 12 },
  { key: "TRANSFER_SERVER_SEP0024", sep: 24 },
  { key: "DIRECT_PAYMENT_SERVER", sep: 31 },
  { key: "ANCHOR_QUOTE_SERVER", sep: 38 },
];

/**
 * Read a top-level key from a stellar.toml.
 *
 * Deliberately not a full TOML parser: only bare `KEY = "value"` or
 * `KEY = 'value'` at the start of a line is accepted, which is how every
 * endpoint key is written — TOML allows either quote style for a basic
 * string, and real anchors use both (cowrie.exchange's live toml is entirely
 * single-quoted). Anything inside a `[[CURRENCIES]]` table or similar is
 * ignored rather than misattributed to the document root.
 */
export function tomlValue(toml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = toml.match(
    new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(?:"([^"]*)"|'([^']*)')`, "m"),
  );
  const value = (m?.[1] ?? m?.[2])?.trim();
  return value ? value : undefined;
}

/**
 * Basic syntax validation of a fetched stellar.toml.
 * Ensures the response is not HTML/XML or malformed content, while cleanly
 * allowing valid TOML tables, array-of-tables, multi-line arrays, comments,
 * and empty/minimal documents.
 */
export function validateToml(content: string): void {
  let toValidate = content;
  // Strip UTF-8 BOM if present
  if (toValidate.startsWith("\uFEFF")) {
    toValidate = toValidate.slice(1);
  }

  const trimmed = toValidate.trim();
  // An empty or whitespace-only document is valid TOML per spec
  if (trimmed.length === 0) {
    return;
  }

  // Reject HTML/XML documents returned with 200 OK (e.g. landing or error pages)
  if (trimmed.startsWith("<") || /^\s*<!doctype\s+html/i.test(trimmed)) {
    throw new SyntaxError("stellar.toml response is HTML/XML, not TOML");
  }

  // Normalize CRLF to LF
  const lines = toValidate.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inMultiLineString: string | null = null;
  let bracketDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // If we are continuing inside a multi-line string (""" or ''')
    if (inMultiLineString) {
      const closeIdx = raw.indexOf(inMultiLineString);
      if (closeIdx !== -1) {
        inMultiLineString = null;
      }
      continue;
    }

    // Strip comments and track strings / brackets across characters
    let inQuote: '"' | "'" | null = null;
    let escaped = false;
    let stripped = "";
    let lineBracketDelta = 0;

    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];

      if (inQuote) {
        stripped += ch;
        if (inQuote === '"') {
          if (escaped) {
            escaped = false;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            inQuote = null;
          }
        } else if (inQuote === "'") {
          if (ch === "'") {
            inQuote = null;
          }
        }
        continue;
      }

      // Not in quotes
      // Check multi-line string open
      if (raw.slice(c, c + 3) === '"""') {
        inMultiLineString = '"""';
        stripped += '"""';
        c += 2;
        const nextClose = raw.indexOf('"""', c + 1);
        if (nextClose !== -1) {
          stripped += raw.slice(c + 1, nextClose + 3);
          c = nextClose + 2;
          inMultiLineString = null;
        }
        continue;
      }
      if (raw.slice(c, c + 3) === "'''") {
        inMultiLineString = "'''";
        stripped += "'''";
        c += 2;
        const nextClose = raw.indexOf("'''", c + 1);
        if (nextClose !== -1) {
          stripped += raw.slice(c + 1, nextClose + 3);
          c = nextClose + 2;
          inMultiLineString = null;
        }
        continue;
      }

      if (ch === '"') {
        inQuote = '"';
        stripped += ch;
        continue;
      }
      if (ch === "'") {
        inQuote = "'";
        stripped += ch;
        continue;
      }

      // Comment start: rest of line is a comment
      if (ch === "#") {
        break;
      }

      // Outside quotes: brackets
      if (ch === "[" || ch === "{") {
        lineBracketDelta++;
      } else if (ch === "]" || ch === "}") {
        lineBracketDelta--;
      }
      stripped += ch;
    }

    const trimmedLine = stripped.trim();
    if (!trimmedLine) continue;

    // Table header check: only when bracketDepth === 0
    if (bracketDepth === 0 && trimmedLine.startsWith("[")) {
      // Must be a valid table header: [table] or [[array_of_tables]]
      const isSingleTable =
        trimmedLine.startsWith("[") &&
        trimmedLine.endsWith("]") &&
        !trimmedLine.startsWith("[[");
      const isArrayTable = trimmedLine.startsWith("[[") && trimmedLine.endsWith("]]");
      if (!isSingleTable && !isArrayTable) {
        throw new SyntaxError(`invalid table header at line ${i + 1}: ${raw.trim()}`);
      }
      continue;
    }

    // Inside a multi-line array or inline table:
    if (bracketDepth > 0) {
      bracketDepth += lineBracketDelta;
      if (bracketDepth < 0) {
        throw new SyntaxError(`unmatched closing bracket at line ${i + 1}: ${raw.trim()}`);
      }
      continue;
    }

    // Top-level key = value line:
    const eqIdx = stripped.indexOf("=");
    if (eqIdx === -1) {
      throw new SyntaxError(`invalid TOML line at line ${i + 1}: missing '='`);
    }
    const val = stripped.slice(eqIdx + 1).trim();
    if (!val && lineBracketDelta === 0) {
      throw new SyntaxError(`missing value at line ${i + 1}: ${raw.trim()}`);
    }

    bracketDepth += lineBracketDelta;
    if (bracketDepth < 0) {
      throw new SyntaxError(`unmatched closing bracket at line ${i + 1}: ${raw.trim()}`);
    }
  }

  if (inMultiLineString) {
    throw new SyntaxError(`unclosed multi-line string (${inMultiLineString})`);
  }
  if (bracketDepth > 0) {
    throw new SyntaxError("unclosed array or inline table in TOML");
  }
}

/**
 * Extracts a 3-digit HTTP status code (100-599) from an error message in linear time
 * without backtracking regular expressions to eliminate ReDoS risk on untrusted input.
 * Matches patterns like "HTTP 404", "status: 500", "status=503", "status 429".
 */
export function extractHttpStatusFromMessage(message: string): number | undefined {
  if (!message || typeof message !== "string") return undefined;

  const lower = message.toLowerCase();
  const len = lower.length;

  let idx = 0;
  while (idx < len) {
    const httpIdx = lower.indexOf("http", idx);
    const statusIdx = lower.indexOf("status", idx);

    if (httpIdx === -1 && statusIdx === -1) {
      break;
    }

    const isHttp = httpIdx !== -1 && (statusIdx === -1 || httpIdx <= statusIdx);
    const matchPrefixLen = isHttp ? 4 : 6;
    const pos = isHttp ? httpIdx : statusIdx;
    idx = pos + matchPrefixLen;

    // Must be word boundary before prefix
    if (pos > 0) {
      const prevChar = lower.charCodeAt(pos - 1);
      if ((prevChar >= 97 && prevChar <= 122) || (prevChar >= 48 && prevChar <= 57)) {
        continue;
      }
    }

    let cur = pos + matchPrefixLen;

    // After "status", skip optional whitespace, optional ':' or '=', and optional whitespace.
    // After "http", require at least one whitespace character.
    if (matchPrefixLen === 4) {
      if (
        cur >= len ||
        (lower[cur] !== " " &&
          lower[cur] !== "\t" &&
          lower[cur] !== "\n" &&
          lower[cur] !== "\r")
      ) {
        continue;
      }
      while (
        cur < len &&
        (lower[cur] === " " ||
          lower[cur] === "\t" ||
          lower[cur] === "\n" ||
          lower[cur] === "\r")
      ) {
        cur++;
      }
    } else {
      while (
        cur < len &&
        (lower[cur] === " " ||
          lower[cur] === "\t" ||
          lower[cur] === "\n" ||
          lower[cur] === "\r")
      ) {
        cur++;
      }
      if (cur < len && (lower[cur] === ":" || lower[cur] === "=")) {
        cur++;
        while (
          cur < len &&
          (lower[cur] === " " ||
            lower[cur] === "\t" ||
            lower[cur] === "\n" ||
            lower[cur] === "\r")
        ) {
          cur++;
        }
      }
    }

    // Check for exactly 3 digits
    if (cur + 3 <= len) {
      const d1 = lower.charCodeAt(cur);
      const d2 = lower.charCodeAt(cur + 1);
      const d3 = lower.charCodeAt(cur + 2);

      if (d1 >= 48 && d1 <= 57 && d2 >= 48 && d2 <= 57 && d3 >= 48 && d3 <= 57) {
        // Must have word boundary after digits (not a 4th digit or letter)
        const nextChar = cur + 3 < len ? lower.charCodeAt(cur + 3) : 32;
        const isWordChar =
          (nextChar >= 48 && nextChar <= 57) || (nextChar >= 97 && nextChar <= 122);
        if (!isWordChar) {
          const code = (d1 - 48) * 100 + (d2 - 48) * 10 + (d3 - 48);
          if (code >= 100 && code <= 599) {
            return code;
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Classifies a stellar.toml fetch failure into one of five categories:
 * dns, timeout, http_<status>, tls, or parse.
 * Returns undefined for unrecognized non-parse errors.
 */
export function classifyTomlFetchError(
  err: unknown,
  status?: number,
): TomlFailureReason | undefined {
  // 1. Explicit status passed in, or status property on error object
  if (typeof status === "number" && (status < 200 || status >= 300)) {
    return `http_${status}`;
  }

  if (err && typeof err === "object") {
    const s = (err as Record<string, unknown>).status;
    if (typeof s === "number" && (s < 200 || s >= 300)) {
      return `http_${s}`;
    }
  }

  const e =
    err instanceof Error
      ? err
      : typeof err === "string"
        ? new Error(err)
        : new Error(String(err));

  const cause =
    e.cause && typeof e.cause === "object" ? (e.cause as Record<string, unknown>) : undefined;

  const msg = (e.message || "").toLowerCase();
  const causeMsg = (
    cause && typeof cause.message === "string" ? cause.message : ""
  ).toLowerCase();
  const code = (
    ((e as unknown as Record<string, unknown>).code as string | undefined) ||
    (cause?.code as string | undefined) ||
    ""
  ).toUpperCase();
  const name = e.name || (cause?.name as string | undefined) || "";

  // 2. HTTP status code in error message (e.g. "HTTP 403", "HTTP 404", "status 502")
  const extractedStatus = extractHttpStatusFromMessage(e.message);
  if (extractedStatus !== undefined) {
    return `http_${extractedStatus}`;
  }

  // 3. Timeout: AbortError, TimeoutError, connect/header timeouts, ETIMEDOUT
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "ABORT_ERR" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("aborted") ||
    causeMsg.includes("timeout") ||
    causeMsg.includes("timed out")
  ) {
    return "timeout";
  }

  // 4. DNS: ENOTFOUND, EAI_AGAIN, EAI_NONAME, ENODATA, EAI_FAIL, ESERVFAIL, getaddrinfo
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EAI_NONAME" ||
    code === "ENODATA" ||
    code === "EAI_FAIL" ||
    code === "ESERVFAIL" ||
    msg.includes("enotfound") ||
    msg.includes("getaddrinfo") ||
    msg.includes("dns lookup") ||
    causeMsg.includes("enotfound") ||
    causeMsg.includes("getaddrinfo") ||
    causeMsg.includes("dns lookup")
  ) {
    return "dns";
  }

  // 5. TLS: CERT_*, ERR_TLS_*, ERR_SSL_*, self-signed, invalid cert, handshake
  if (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_GET_ISSUER_CERT" ||
    msg.includes("certificate") ||
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("handshake") ||
    causeMsg.includes("certificate") ||
    causeMsg.includes("tls") ||
    causeMsg.includes("ssl")
  ) {
    return "tls";
  }

  // 6. Parse / Syntax: SyntaxError, TOML parse errors, invalid syntax, HTML/XML response
  if (
    e instanceof SyntaxError ||
    name === "SyntaxError" ||
    code === "ERR_INVALID_TOML" ||
    code === "ERR_PARSE" ||
    msg.includes("parse") ||
    msg.includes("syntax") ||
    msg.includes("malformed") ||
    msg.includes("invalid toml") ||
    msg.includes("html/xml") ||
    causeMsg.includes("parse") ||
    causeMsg.includes("syntax") ||
    causeMsg.includes("malformed") ||
    causeMsg.includes("invalid toml") ||
    causeMsg.includes("html/xml")
  ) {
    return "parse";
  }

  // Unknown non-parse errors are not classified as parse
  return undefined;
}

export async function probeAnchor(
  domain: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  const userAgent = opts.userAgent ?? PROBE_USER_AGENT;
  const outcomes: ProbeOutcome[] = [];

  let seps = 0;
  let probesRun = 0;
  let probesPassed = 0;
  let tomlHash = ZERO_HASH;

  // Single choke point: every endpoint fetched past the initial SEP-1 request
  // is a URL the anchor's own stellar.toml supplied. Refuse anything that
  // isn't a public https:// host before it's dereferenced — see url-safety.ts.
  const get = (
    url: string,
    init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ) => {
    if (!isSafeUrl(url)) {
      return Promise.reject(new Error(`refusing to fetch unsafe url: ${url}`));
    }
    const headers: Record<string, string> = {
      "user-agent": userAgent,
      ...init?.headers,
    };
    return doFetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  };

  const record = (probe: ProbeName, passed: boolean, detail: string) => {
    probesRun |= probeBit(probe);
    if (passed) probesPassed |= probeBit(probe);
    outcomes.push({ probe, passed, detail });
  };
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // --- SEP-1 -------------------------------------------------------------
  let toml: string;
  try {
    const res = await get(`https://${domain}/.well-known/stellar.toml`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toml = await res.text();
    validateToml(toml);
    tomlHash = tomlHashText(toml);
    seps |= sepBit(1);
    record("toml_fetch", true, `sha256 ${tomlHash.slice(0, 16)}…`);
  } catch (e) {
    const tomlFailureReason = classifyTomlFetchError(e);
    record("toml_fetch", false, why(e));
    // No toml means nothing else can be discovered. Returning here keeps
    // probesRun honest: we did not attempt what we could not reach.
    return {
      domain,
      seps,
      probesRun,
      probesPassed,
      tomlHash,
      outcomes,
      ...(tomlFailureReason ? { tomlFailureReason } : {}),
    };
  }

  const endpoint = new Map<SepNumber, string>();
  for (const { key, sep } of TOML_ENDPOINTS) {
    const url = tomlValue(toml, key);
    if (url) {
      endpoint.set(sep, url);
      seps |= sepBit(sep);
    }
  }

  // Declared, straight from the toml we just hashed — no endpoint is involved,
  // so this is read whether or not any probe past SEP-1 gets a chance to run.
  const country = declaredCountry(toml);

  // --- SEP-10: a full handshake, not a reachability check ----------------
  let token: string | undefined;
  const webAuth = endpoint.get(10);
  if (webAuth) {
    try {
      const kp = opts.keypair ?? Keypair.random();
      const challengeRes = await get(
        `${webAuth}?account=${kp.publicKey()}&home_domain=${domain}`,
      );
      if (!challengeRes.ok) throw new Error(`challenge HTTP ${challengeRes.status}`);
      const ch = (await challengeRes.json()) as {
        transaction?: string;
        network_passphrase?: string;
      };
      if (!ch.transaction || !ch.network_passphrase) {
        throw new Error("challenge missing transaction/network_passphrase");
      }
      const tx = TransactionBuilder.fromXDR(
        ch.transaction,
        ch.network_passphrase,
      ) as Transaction;
      tx.sign(kp);
      const tokenRes = await get(webAuth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: tx.toXDR() }),
      });
      if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
      const out = (await tokenRes.json()) as { token?: string };
      if (!out.token) throw new Error("no token returned");
      token = out.token;
      record("sep10_auth", true, "challenge signed, JWT issued");
    } catch (e) {
      record("sep10_auth", false, why(e));
    }
  }

  const authHeader: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  // --- SEP-38: a FIRM quote that has not already expired -----------------
  const sep38 = endpoint.get(38);
  if (sep38) {
    try {
      const infoRes = await get(`${sep38}/info`);
      if (!infoRes.ok) throw new Error(`info HTTP ${infoRes.status}`);
      const info = (await infoRes.json()) as { assets?: { asset: string }[] };
      const sell = info.assets?.find((a) => a.asset.startsWith("stellar:"));
      const buy = info.assets?.find((a) => a.asset.startsWith("iso4217:"));
      if (!sell || !buy) throw new Error("no stellar→fiat pair advertised");

      const context = endpoint.has(6) && !endpoint.has(31) ? "sep6" : "sep31";
      const res = await get(`${sep38}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader },
        body: JSON.stringify({
          context,
          sell_asset: sell.asset,
          buy_asset: buy.asset,
          sell_amount: "10",
        }),
      });
      if (!res.ok) throw new Error(`quote HTTP ${res.status}`);
      const q = (await res.json()) as { expires_at?: string };
      const expiry = q.expires_at ? Date.parse(q.expires_at) : NaN;
      if (!Number.isFinite(expiry)) throw new Error("quote has no parsable expires_at");
      // An already-expired firm quote is not a working quote server.
      if (expiry <= now()) throw new Error(`quote already expired (${q.expires_at})`);
      record("sep38_quote", true, `firm quote expires ${q.expires_at}`);
    } catch (e) {
      record("sep38_quote", false, why(e));
    }
  }

  // --- SEP-12: does the endpoint speak the protocol at all? --------------
  const kyc = endpoint.get(12);
  if (kyc && token) {
    try {
      const res = await get(`${kyc}/customer?type=sep31-receiver`, { headers: authHeader });
      // A 4xx is a valid SEP-12 answer ("no such customer"); a 5xx or a
      // connection failure is not. We are probing that it speaks the protocol,
      // not that any particular customer exists.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      record("sep12_status", true, `HTTP ${res.status}`);
    } catch (e) {
      record("sep12_status", false, why(e));
    }
  }

  // --- SEP-31: does it receive anything? ---------------------------------
  let sep31ReceiveAssets: string[] | undefined;
  let receiveLimits: ReceiveAssetLimits[] | undefined;
  const sep31 = endpoint.get(31);
  if (sep31) {
    try {
      const res = await get(`${sep31}/info`, { headers: authHeader });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { receive?: Record<string, unknown> };
      const assets = Object.keys(j.receive ?? {});
      if (assets.length === 0) {
        // The distinction that matters for an off-ramp registry: the endpoint
        // exists, the lane does not.
        throw new Error("receive list is EMPTY — advertises SEP-31 but accepts nothing");
      }
      sep31ReceiveAssets = assets;
      // The bounds stated beside each asset, from the same response, so the list
      // and its limits cannot describe two different moments.
      receiveLimits = receiveLimitsFrom(j.receive ?? {});
      record("sep31_info", true, `receives ${assets.join(", ")}`);
    } catch (e) {
      record("sep31_info", false, why(e));
    }
  }

  // --- SEP-6: does the transfer server withdraw anything? ----------------
  const sep6 = endpoint.get(6);
  let sep6Asset: string | undefined;
  if (sep6) {
    try {
      const res = await get(`${sep6}/info`, { headers: authHeader });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      type Sep6Section = Record<string, { enabled?: boolean }>;
      const j = (await res.json()) as {
        withdraw?: Sep6Section;
        "withdraw-exchange"?: Sep6Section;
      };
      // SEP-6 requires `enabled` on every asset; an asset that is not explicitly
      // enabled is not a working lane, the same way an empty SEP-31 receive list is not.
      const enabled = (section: Sep6Section | undefined) =>
        Object.entries(section ?? {})
          .filter(([, v]) => v?.enabled === true)
          .map(([code]) => code);
      const assets = [
        ...new Set([...enabled(j.withdraw), ...enabled(j["withdraw-exchange"])]),
      ];
      if (assets.length === 0) {
        throw new Error("withdraw list is EMPTY — advertises SEP-6 but withdraws nothing");
      }
      sep6Asset = assets[0];
      record("sep6_info", true, `withdraws ${assets.join(", ")}`);
    } catch (e) {
      record("sep6_info", false, why(e));
    }
  }

  // --- SEP-6 auth: an authenticated read, not just a public /info --------
  if (sep6 && token && sep6Asset) {
    try {
      const res = await get(
        `${sep6}/transactions?asset_code=${encodeURIComponent(sep6Asset)}`,
        { headers: authHeader },
      );
      // As with SEP-12: a 4xx is a valid SEP-6 answer, a 5xx is not.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      record("sep6_auth", true, `HTTP ${res.status}`);
    } catch (e) {
      record("sep6_auth", false, why(e));
    }
  }

  return {
    domain,
    seps,
    probesRun,
    probesPassed,
    tomlHash,
    outcomes,
    toml,
    ...(sep31ReceiveAssets ? { sep31ReceiveAssets, receiveAssets: sep31ReceiveAssets } : {}),
    ...(receiveLimits ? { receiveLimits } : {}),
    ...(country ? { country } : {}),
  };
}

export interface FormattedProbeResultJson {
  readonly domain: string;
  readonly tomlHash: string;
  readonly outcomes: readonly ProbeOutcome[];
  readonly seps: readonly SepNumber[];
  readonly probesPassed: readonly ProbeName[];
  readonly probesRun: readonly ProbeName[];
  readonly tomlFailureReason?: TomlFailureReason;
  readonly sep31ReceiveAssets?: readonly string[];
  readonly receiveAssets?: readonly string[];
  readonly receiveLimits?: readonly ReceiveAssetLimits[];
  readonly raw: {
    readonly seps: number;
    readonly probesRun: number;
    readonly probesPassed: number;
  };
}

/**
 * Format a ProbeResult into a clean JSON string with decoded SEP numbers and probe names.
 */
export function formatProbeResultJson(result: ProbeResult): string {
  const data: FormattedProbeResultJson = {
    ...result,
    seps: decodeSeps(result.seps),
    probesPassed: decodeProbes(result.probesPassed),
    probesRun: decodeProbes(result.probesRun),
    raw: {
      seps: result.seps,
      probesRun: result.probesRun,
      probesPassed: result.probesPassed,
    },
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Parse CLI arguments for probe:anchor, extracting domain and --json flag.
 */
export function parseProbeArgs(args: readonly string[]): { domain?: string; json: boolean } {
  let domain: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-") && !domain) {
      domain = arg;
    }
  }
  return { domain, json };
}

export * from "./report";
export * from "./loader";
export * from "./receive";
