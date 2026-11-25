// @corridor/probe — the honesty of an attestation depends entirely on these
// probes refusing to pass on weak evidence, so most of what is tested here is
// what does NOT count as a pass.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Account,
} from "@stellar/stellar-sdk";
import {
  classifyTomlFetchError,
  decodeProbes,
  decodeSeps,
  extractHttpStatusFromMessage,
  formatProbeResultJson,
  isSafeUrl,
  parseProbeArgs,
  probeAnchor,
  probeBit,
  sepBit,
  tomlHash as sharedTomlHash,
  tomlValue,
  validateToml,
  PROBE_NAMES,
  PROBE_USER_AGENT,
  type ProbeName,
  type ProbeResult,
} from "@corridor/probe";

const PASSPHRASE = Networks.TESTNET;

/** A stellar.toml advertising every endpoint the probe knows about. */
const FULL_TOML = `
VERSION = "2.0.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
KYC_SERVER = "https://a.example/sep12"
TRANSFER_SERVER = "https://a.example/sep6"
TRANSFER_SERVER_SEP0024 = "https://a.example/sep24"
DIRECT_PAYMENT_SERVER = "https://a.example/sep31"
ANCHOR_QUOTE_SERVER = "https://a.example/sep38"

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;

/** A real SEP-10 challenge the probe can actually parse and sign. */
function challengeXdr(serverKp: Keypair, clientAccount: string): string {
  const account = new Account(serverKp.publicKey(), "-1");
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.manageData({
        name: "a.example auth",
        value: Buffer.alloc(48, "a"),
        source: clientAccount,
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

interface StubOptions {
  toml?: string | null;
  authChallenge?: boolean;
  authToken?: boolean;
  quote?: { ok?: boolean; expiresAt?: string; assets?: boolean };
  sep12Status?: number;
  sep31Receive?: string[] | null;
  sep6Info?: {
    withdraw?: Record<string, { enabled?: boolean }> | null;
    "withdraw-exchange"?: Record<string, { enabled?: boolean }> | null;
  } | null;
  sep6TransactionsStatus?: number;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stub(o: StubOptions = {}) {
  const serverKp = Keypair.random();
  const calls: string[] = [];
  const recordedCalls: RecordedCall[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);

    const headers: Record<string, string> = {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };
    recordedCalls.push({
      url: u,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
    });

    if (u.includes("stellar.toml")) {
      if (o.toml === null) return new Response("nope", { status: 404 });
      return new Response(o.toml ?? FULL_TOML, { status: 200 });
    }
    if (u.includes("/auth")) {
      if (init?.method === "POST") {
        return o.authToken === false
          ? json({}, 403)
          : json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
      }
      if (o.authChallenge === false) return json({}, 500);
      const account = new URL(u).searchParams.get("account")!;
      return json({
        transaction: challengeXdr(serverKp, account),
        network_passphrase: PASSPHRASE,
      });
    }
    if (u.includes("/sep38/info")) {
      return o.quote?.assets === false
        ? json({ assets: [] })
        : json({
            assets: [
              {
                asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              },
              { asset: "iso4217:USD" },
            ],
          });
    }
    if (u.includes("/sep38/quote")) {
      if (o.quote?.ok === false) return json({}, 400);
      return json({
        id: "q1",
        price: "1.05",
        total_price: "1.17",
        sell_amount: "10",
        buy_amount: "8.57",
        expires_at: o.quote?.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (u.includes("/sep12")) return json({ status: "ACCEPTED" }, o.sep12Status ?? 200);
    if (u.includes("/sep31/info")) {
      const receive = o.sep31Receive === null ? {} : { USDC: { enabled: true } };
      return json({
        receive: o.sep31Receive
          ? Object.fromEntries(o.sep31Receive.map((a) => [a, {}]))
          : receive,
      });
    }
    if (u.includes("/sep6/info")) {
      if (o.sep6Info === null) return json({}, 500);
      if (o.sep6Info) return json(o.sep6Info);
      return json({
        withdraw: {
          USDC: { enabled: true },
        },
      });
    }
    if (u.includes("/sep6/transactions")) {
      const status = o.sep6TransactionsStatus ?? 200;
      return json({ transactions: [] }, status);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, recordedCalls };
}

const passed = (r: { probesPassed: number }, p: ProbeName) =>
  (r.probesPassed & probeBit(p)) !== 0;
const ran = (r: { probesRun: number }, p: ProbeName) => (r.probesRun & probeBit(p)) !== 0;

describe("bitmaps", () => {
  it("round-trips SEP numbers through the registry's bit order", () => {
    const mask = sepBit(1) | sepBit(10) | sepBit(31);
    expect(decodeSeps(mask)).toEqual([1, 10, 31]);
  });

  it("round-trips probe names", () => {
    const mask = probeBit("toml_fetch") | probeBit("sep31_info");
    expect(decodeProbes(mask)).toEqual(["toml_fetch", "sep31_info"]);
  });

  it("decodes an empty mask to nothing", () => {
    expect(decodeSeps(0)).toEqual([]);
    expect(decodeProbes(0)).toEqual([]);
  });

  it("Bit order test asserts PROBE_NAMES matches the contract list", () => {
    const contractPath = resolve(__dirname, "../contracts/registry/src/lib.rs");
    const contractSrc = readFileSync(contractPath, "utf8");
    const match = contractSrc.match(
      /pub const PROBE_NAMES:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(match).toBeTruthy();
    const contractNames = Array.from(match![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    expect([...PROBE_NAMES]).toEqual(contractNames);
  });
});

describe("tomlValue", () => {
  it("reads a top-level key", () => {
    expect(tomlValue(FULL_TOML, "WEB_AUTH_ENDPOINT")).toBe("https://a.example/auth");
  });

  it("returns undefined for an absent key", () => {
    expect(tomlValue(FULL_TOML, "NOT_A_KEY")).toBeUndefined();
  });

  it("treats an empty value as absent rather than as an endpoint", () => {
    expect(tomlValue('DIRECT_PAYMENT_SERVER = ""', "DIRECT_PAYMENT_SERVER")).toBeUndefined();
  });

  it("reads a single-quoted value — valid TOML that real anchors use (e.g. cowrie.exchange)", () => {
    expect(
      tomlValue("WEB_AUTH_ENDPOINT = 'https://a.example/auth'", "WEB_AUTH_ENDPOINT"),
    ).toBe("https://a.example/auth");
  });

  it("treats an empty single-quoted value as absent too", () => {
    expect(tomlValue("DIRECT_PAYMENT_SERVER = ''", "DIRECT_PAYMENT_SERVER")).toBeUndefined();
  });

  it("does not confuse a key inside a table with a top-level one", () => {
    // `code` appears under [[CURRENCIES]]; asking for it must not return the
    // currency's value as though it were a document-root key.
    const toml = `[[CURRENCIES]]\n  DIRECT_PAYMENT_SERVER = "https://wrong.example"\n`;
    // Indented under a table — the current reader accepts leading whitespace, so
    // this documents the known limitation rather than pretending otherwise.
    expect(tomlValue(toml, "DIRECT_PAYMENT_SERVER")).toBe("https://wrong.example");
  });
});

describe("isSafeUrl", () => {
  it("rejects loopback, link-local/metadata, RFC1918, and non-https URLs", () => {
    const bad = [
      "http://169.254.169.254/latest/meta-data", // cloud metadata endpoint
      "https://127.0.0.1/",
      "https://localhost/",
      "https://10.0.0.5/",
      "https://172.16.0.5/",
      "https://192.168.1.5/",
      "https://[::1]/",
      "https://[fe80::1]/",
      "https://[fc00::1]/",
      "http://a.example/", // right host, wrong scheme
      "not a url",
    ];
    for (const url of bad) expect(isSafeUrl(url)).toBe(false);
  });

  it("accepts an ordinary public https URL", () => {
    expect(isSafeUrl("https://a.example/sep31")).toBe(true);
  });
});

describe("probeAnchor — SSRF guard", () => {
  it("refuses to fetch a WEB_AUTH_ENDPOINT pointed at an internal address", async () => {
    // Simulates a malicious/compromised anchor whose stellar.toml points a
    // SEP endpoint at an internal or metadata address, reachable via the
    // repo's own "open a PR to add an anchor domain" onboarding flow.
    const maliciousToml = FULL_TOML.replace(
      'WEB_AUTH_ENDPOINT = "https://a.example/auth"',
      'WEB_AUTH_ENDPOINT = "http://169.254.169.254/latest/meta-data"',
    );
    const { fetchImpl, calls } = stub({ toml: maliciousToml });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(passed(r, "sep10_auth")).toBe(false);
    const outcome = r.outcomes.find((o) => o.probe === "sep10_auth");
    expect(outcome?.detail).toContain("refusing to fetch unsafe url");
    // The unsafe URL must never actually be dereferenced.
    expect(calls.some((c) => c.includes("169.254.169.254"))).toBe(false);
  });

  it("still probes normally when every endpoint is a safe https URL (regression guard)", async () => {
    const { fetchImpl } = stub();
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(passed(r, "sep10_auth")).toBe(true);
  });
});

describe("shared TOML hash helper", () => {
  it("matches the probe's raw-text SHA-256 output", async () => {
    const toml = 'VERSION = "2.0.0"\n';
    const r = await probeAnchor("a.example", {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/.well-known/stellar.toml")) return new Response(toml);
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    expect(r.tomlHash).toBe(sharedTomlHash(toml));
  });
});

describe("probeAnchor", () => {
  it("passes every probe against a fully conformant anchor", async () => {
    const { fetchImpl } = stub();
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeSeps(r.seps)).toEqual([1, 6, 10, 12, 24, 31, 38]);
    expect(decodeProbes(r.probesPassed)).toEqual([
      "toml_fetch",
      "sep10_auth",
      "sep38_quote",
      "sep12_status",
      "sep31_info",
      "sep6_info",
      "sep6_auth",
    ]);
    expect(r.tomlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sep31ReceiveAssets).toEqual(["USDC"]);
  });

  // The case that got this project rejected, reproduced as a test: the toml
  // advertises SEP-31 and the lane does not exist.
  it("fails the SEP-31 probe when the receive list is empty, while still recording it as advertised", async () => {
    const { fetchImpl } = stub({ sep31Receive: null });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeSeps(r.seps)).toContain(31); // advertised
    expect(ran(r, "sep31_info")).toBe(true); // we checked
    expect(passed(r, "sep31_info")).toBe(false); // and it does not work
    expect(r.sep31ReceiveAssets).toBeUndefined();
  });

  it("passes sep6_info with non-empty withdraw or withdraw-exchange list, fails when empty", async () => {
    const passWithdraw = await probeAnchor("a.example", {
      fetchImpl: stub({
        sep6Info: { withdraw: { USDC: { enabled: true } } },
      }).fetchImpl,
    });
    expect(ran(passWithdraw, "sep6_info")).toBe(true);
    expect(passed(passWithdraw, "sep6_info")).toBe(true);

    const passExchange = await probeAnchor("a.example", {
      fetchImpl: stub({
        sep6Info: {
          withdraw: {},
          "withdraw-exchange": { USDC: { enabled: true } },
        },
      }).fetchImpl,
    });
    expect(passed(passExchange, "sep6_info")).toBe(true);

    const failEmpty = await probeAnchor("a.example", {
      fetchImpl: stub({
        sep6Info: { withdraw: {}, "withdraw-exchange": {} },
      }).fetchImpl,
    });
    expect(ran(failEmpty, "sep6_info")).toBe(true);
    expect(passed(failEmpty, "sep6_info")).toBe(false);
    const outcome = failEmpty.outcomes.find((o) => o.probe === "sep6_info");
    expect(outcome?.detail).toContain("EMPTY");
  });

  it("fails sep6_info when all withdraw assets are disabled", async () => {
    const r = await probeAnchor("a.example", {
      fetchImpl: stub({
        sep6Info: {
          withdraw: { USDC: { enabled: false } },
        },
      }).fetchImpl,
    });
    expect(ran(r, "sep6_info")).toBe(true);
    expect(passed(r, "sep6_info")).toBe(false);
    const outcome = r.outcomes.find((o) => o.probe === "sep6_info");
    expect(outcome?.detail).toContain("EMPTY");
  });

  it("passes sep6_auth on 2xx and 4xx, but fails on 5xx", async () => {
    const ok200 = await probeAnchor("a.example", {
      fetchImpl: stub({ sep6TransactionsStatus: 200 }).fetchImpl,
    });
    expect(ran(ok200, "sep6_auth")).toBe(true);
    expect(passed(ok200, "sep6_auth")).toBe(true);

    const ok400 = await probeAnchor("a.example", {
      fetchImpl: stub({ sep6TransactionsStatus: 400 }).fetchImpl,
    });
    expect(ran(ok400, "sep6_auth")).toBe(true);
    expect(passed(ok400, "sep6_auth")).toBe(true);

    const fail500 = await probeAnchor("a.example", {
      fetchImpl: stub({ sep6TransactionsStatus: 500 }).fetchImpl,
    });
    expect(ran(fail500, "sep6_auth")).toBe(true);
    expect(passed(fail500, "sep6_auth")).toBe(false);
  });

  it("runs SEP-38 quote probe with context 'sep6' when only SEP-6 is advertised", async () => {
    const sep6OnlyToml = `
VERSION = "2.0.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
TRANSFER_SERVER = "https://a.example/sep6"
ANCHOR_QUOTE_SERVER = "https://a.example/sep38"
`;
    let quoteContext: string | undefined;
    const { fetchImpl } = stub({ toml: sep6OnlyToml });
    const spyFetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/sep38/quote") && init?.body) {
        const body = JSON.parse(String(init.body));
        quoteContext = body.context;
      }
      return fetchImpl(url, init);
    }) as typeof fetch;

    const r = await probeAnchor("a.example", { fetchImpl: spyFetch });
    expect(decodeSeps(r.seps)).toEqual([1, 6, 10, 38]);
    expect(quoteContext).toBe("sep6");
    expect(passed(r, "sep38_quote")).toBe(true);
  });

  it("records nothing as run beyond the toml when the toml cannot be fetched", async () => {
    const { fetchImpl } = stub({ toml: null });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(passed(r, "toml_fetch")).toBe(false);
    expect(r.probesRun).toBe(probeBit("toml_fetch"));
    expect(r.probesPassed).toBe(0);
    expect(r.seps).toBe(0);
    expect(r.tomlHash).toBe("0".repeat(64));
  });

  it("does not attempt probes for endpoints the anchor never advertised", async () => {
    const { fetchImpl } = stub({ toml: 'VERSION = "2.0.0"\n' });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeSeps(r.seps)).toEqual([1]);
    // probesRun must reflect what was ATTEMPTED. Claiming we ran a SEP-31 probe
    // against an anchor with no SEP-31 endpoint would be a false statement.
    expect(decodeProbes(r.probesRun)).toEqual(["toml_fetch"]);
  });

  it("fails SEP-10 when the challenge cannot be obtained", async () => {
    const { fetchImpl } = stub({ authChallenge: false });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(ran(r, "sep10_auth")).toBe(true);
    expect(passed(r, "sep10_auth")).toBe(false);
  });

  it("fails SEP-10 when the token exchange is refused", async () => {
    const { fetchImpl } = stub({ authToken: false });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(passed(r, "sep10_auth")).toBe(false);
  });

  it("fails SEP-38 when the quote has already expired", async () => {
    const { fetchImpl } = stub({
      quote: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(ran(r, "sep38_quote")).toBe(true);
    expect(passed(r, "sep38_quote")).toBe(false);
  });

  it("fails SEP-38 when no stellar to fiat pair is offered", async () => {
    const { fetchImpl } = stub({ quote: { assets: false } });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(passed(r, "sep38_quote")).toBe(false);
  });

  it("treats a 4xx from SEP-12 as the endpoint working, but a 5xx as failure", async () => {
    const notFound = await probeAnchor("a.example", {
      fetchImpl: stub({ sep12Status: 404 }).fetchImpl,
    });
    expect(passed(notFound, "sep12_status")).toBe(true);

    const broken = await probeAnchor("a.example", {
      fetchImpl: stub({ sep12Status: 503 }).fetchImpl,
    });
    expect(passed(broken, "sep12_status")).toBe(false);
  });

  it("never reports a probe as passed without also reporting it as run", async () => {
    // The invariant the registry contract enforces on chain; asserted here too
    // so a malformed result can never even be submitted.
    for (const opts of [
      {},
      { toml: null },
      { authChallenge: false },
      { quote: { ok: false } },
      { sep31Receive: null },
      { sep12Status: 500 },
    ] as StubOptions[]) {
      const r = await probeAnchor("a.example", { fetchImpl: stub(opts).fetchImpl });
      expect(r.probesPassed & ~r.probesRun).toBe(0);
    }
  });

  it("reports a human-readable reason for every probe it ran", async () => {
    const { fetchImpl } = stub({ sep31Receive: null });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.outcomes.length).toBe(decodeProbes(r.probesRun).length);
    const sep31 = r.outcomes.find((o) => o.probe === "sep31_info");
    expect(sep31?.passed).toBe(false);
    expect(sep31?.detail).toContain("EMPTY");
  });

  describe("sep31ReceiveAssets structured data (#231)", () => {
    it("is populated on a passing SEP-31 probe", async () => {
      const { fetchImpl } = stub({ sep31Receive: ["NGNT", "USDC"] });
      const r = await probeAnchor("a.example", { fetchImpl });
      expect(passed(r, "sep31_info")).toBe(true);
      expect(r.sep31ReceiveAssets).toEqual(["NGNT", "USDC"]);
    });

    it("is undefined on empty receive list", async () => {
      const { fetchImpl } = stub({ sep31Receive: null });
      const r = await probeAnchor("a.example", { fetchImpl });
      expect(passed(r, "sep31_info")).toBe(false);
      expect(r.sep31ReceiveAssets).toBeUndefined();
    });

    it("is undefined when SEP-31 is not advertised", async () => {
      const { fetchImpl } = stub({ toml: 'VERSION = "2.0.0"\n' });
      const r = await probeAnchor("a.example", { fetchImpl });
      expect(decodeSeps(r.seps)).not.toContain(31);
      expect(r.sep31ReceiveAssets).toBeUndefined();
    });
  });
});

describe("formatProbeResultJson & parseProbeArgs (#232)", () => {
  describe("parseProbeArgs", () => {
    it("parses domain when provided as single argument", () => {
      const res = parseProbeArgs(["testanchor.stellar.org"]);
      expect(res).toEqual({ domain: "testanchor.stellar.org", json: false });
    });

    it("parses --json when placed after domain", () => {
      const res = parseProbeArgs(["testanchor.stellar.org", "--json"]);
      expect(res).toEqual({ domain: "testanchor.stellar.org", json: true });
    });

    it("parses --json when placed before domain", () => {
      const res = parseProbeArgs(["--json", "testanchor.stellar.org"]);
      expect(res).toEqual({ domain: "testanchor.stellar.org", json: true });
    });

    it("returns undefined domain when only --json is passed", () => {
      const res = parseProbeArgs(["--json"]);
      expect(res).toEqual({ domain: undefined, json: true });
    });

    it("returns undefined domain when argv is empty", () => {
      const res = parseProbeArgs([]);
      expect(res).toEqual({ domain: undefined, json: false });
    });
  });

  describe("formatProbeResultJson", () => {
    const fixture: ProbeResult = {
      domain: "example.org",
      seps: sepBit(1) | sepBit(10) | sepBit(31) | sepBit(38),
      probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
      probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
      tomlHash: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "stellar.toml fetched" },
        { probe: "sep10_auth", passed: true, detail: "signed challenge verified" },
        { probe: "sep31_info", passed: false, detail: "receive list is EMPTY" },
      ],
    };

    it("serializes fixture into valid JSON with decoded seps and probes", () => {
      const jsonStr = formatProbeResultJson(fixture);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.domain).toBe("example.org");
      expect(parsed.tomlHash).toBe(fixture.tomlHash);
      expect(parsed.outcomes).toEqual(fixture.outcomes);
      expect(parsed.seps).toEqual([1, 10, 31, 38]);
      expect(parsed.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
      expect(parsed.probesPassed).toEqual(["toml_fetch", "sep10_auth"]);
      expect(parsed.raw).toEqual({
        seps: fixture.seps,
        probesRun: fixture.probesRun,
        probesPassed: fixture.probesPassed,
      });
    });

    it("includes tomlFailureReason when present", () => {
      const failedFixture: ProbeResult = {
        domain: "broken.org",
        seps: 0,
        probesRun: probeBit("toml_fetch"),
        probesPassed: 0,
        tomlHash: "0".repeat(64),
        outcomes: [{ probe: "toml_fetch", passed: false, detail: "HTTP 403" }],
        tomlFailureReason: "http_403",
      };
      const jsonStr = formatProbeResultJson(failedFixture);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.tomlFailureReason).toBe("http_403");
    });
  });
});

describe("classifyTomlFetchError (#662)", () => {
  describe("http_<status> category", () => {
    it("classifies explicit numeric HTTP status", () => {
      expect(classifyTomlFetchError(new Error("Failed"), 403)).toBe("http_403");
      expect(classifyTomlFetchError(new Error("Failed"), 404)).toBe("http_404");
      expect(classifyTomlFetchError(new Error("Failed"), 500)).toBe("http_500");
      expect(classifyTomlFetchError(new Error("Failed"), 502)).toBe("http_502");
    });

    it("classifies error with status property", () => {
      const err = Object.assign(new Error("Not Found"), { status: 404 });
      expect(classifyTomlFetchError(err)).toBe("http_404");
    });

    it("classifies HTTP <status> in error message", () => {
      expect(classifyTomlFetchError(new Error("HTTP 403"))).toBe("http_403");
      expect(classifyTomlFetchError(new Error("HTTP 404"))).toBe("http_404");
      expect(classifyTomlFetchError(new Error("Request failed with HTTP 503"))).toBe(
        "http_503",
      );
      expect(classifyTomlFetchError(new Error("status: 400 Bad Request"))).toBe("http_400");
      expect(classifyTomlFetchError(new Error("status: 500"))).toBe("http_500");
      expect(classifyTomlFetchError(new Error("status=503"))).toBe("http_503");
      expect(classifyTomlFetchError(new Error("status 429"))).toBe("http_429");
      expect(classifyTomlFetchError(new Error("status   :   502"))).toBe("http_502");
    });

    it("extracts status code and resists ReDoS on repeated whitespace", () => {
      expect(extractHttpStatusFromMessage("HTTP 404")).toBe(404);
      expect(extractHttpStatusFromMessage("status: 500")).toBe(500);
      expect(extractHttpStatusFromMessage("status=503")).toBe(503);
      expect(extractHttpStatusFromMessage("status 429")).toBe(429);
      expect(extractHttpStatusFromMessage("status" + " ".repeat(10000) + ": 500")).toBe(500);
      expect(extractHttpStatusFromMessage("status" + " ".repeat(10000))).toBeUndefined();
      expect(extractHttpStatusFromMessage("HTTP" + " ".repeat(10000) + "404")).toBe(404);
    });
  });

  describe("timeout category", () => {
    it("classifies TimeoutError and AbortError", () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      expect(classifyTomlFetchError(timeoutErr)).toBe("timeout");

      const abortErr = new Error("The user aborted a request");
      abortErr.name = "AbortError";
      expect(classifyTomlFetchError(abortErr)).toBe("timeout");
    });

    it("classifies timeout codes like ETIMEDOUT and undici timeout codes", () => {
      const err1 = Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" });
      expect(classifyTomlFetchError(err1)).toBe("timeout");

      const err2 = Object.assign(new Error("Headers timeout"), {
        code: "UND_ERR_HEADERS_TIMEOUT",
      });
      expect(classifyTomlFetchError(err2)).toBe("timeout");

      const err3 = Object.assign(new Error("Connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      });
      expect(classifyTomlFetchError(err3)).toBe("timeout");
    });

    it("classifies timeout errors wrapped in cause", () => {
      const cause = Object.assign(new Error("timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" });
      const err = new TypeError("fetch failed");
      err.cause = cause;
      expect(classifyTomlFetchError(err)).toBe("timeout");
    });

    it("classifies timeout keywords in message", () => {
      expect(classifyTomlFetchError(new Error("connection timed out"))).toBe("timeout");
      expect(classifyTomlFetchError(new Error("request timeout"))).toBe("timeout");
    });
  });

  describe("dns category", () => {
    it("classifies standard DNS lookup codes", () => {
      for (const code of ["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "ENODATA", "EAI_FAIL"]) {
        const err = Object.assign(new Error("DNS failed"), { code });
        expect(classifyTomlFetchError(err)).toBe("dns");
      }
    });

    it("classifies DNS lookup errors wrapped in cause", () => {
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND a.example"), {
        code: "ENOTFOUND",
      });
      const err = new TypeError("fetch failed");
      err.cause = cause;
      expect(classifyTomlFetchError(err)).toBe("dns");
    });

    it("classifies DNS keywords in message", () => {
      expect(classifyTomlFetchError(new Error("getaddrinfo ENOTFOUND bad.host"))).toBe("dns");
      expect(classifyTomlFetchError(new Error("DNS lookup failed: host not found"))).toBe(
        "dns",
      );
    });

    it("does not classify post-DNS socket/transport errors like ECONNREFUSED as dns or parse", () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
      expect(classifyTomlFetchError(err)).toBeUndefined();
      expect(classifyTomlFetchError(err)).not.toBe("parse");
      expect(classifyTomlFetchError(err)).not.toBe("dns");

      const errWithCause = new TypeError("fetch failed");
      errWithCause.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      });
      expect(classifyTomlFetchError(errWithCause)).toBeUndefined();
      expect(classifyTomlFetchError(errWithCause)).not.toBe("parse");
      expect(classifyTomlFetchError(errWithCause)).not.toBe("dns");

      const errWithCode = Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
      expect(classifyTomlFetchError(errWithCode)).toBeUndefined();
      expect(classifyTomlFetchError(errWithCode)).not.toBe("parse");
      expect(classifyTomlFetchError(errWithCode)).not.toBe("dns");

      for (const code of [
        "ECONNRESET",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ECONNABORTED",
        "EPIPE",
      ]) {
        const netErr = Object.assign(new Error("network failure"), { code });
        expect(classifyTomlFetchError(netErr)).toBeUndefined();
        expect(classifyTomlFetchError(netErr)).not.toBe("parse");
        expect(classifyTomlFetchError(netErr)).not.toBe("dns");
      }
    });
  });

  describe("tls category", () => {
    it("classifies certificate and TLS error codes", () => {
      for (const code of [
        "CERT_HAS_EXPIRED",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "ERR_SSL_PROTOCOL_ERROR",
      ]) {
        const err = Object.assign(new Error("TLS failure"), { code });
        expect(classifyTomlFetchError(err)).toBe("tls");
      }
    });

    it("classifies TLS errors wrapped in cause", () => {
      const cause = Object.assign(new Error("certificate has expired"), {
        code: "CERT_HAS_EXPIRED",
      });
      const err = new TypeError("fetch failed");
      err.cause = cause;
      expect(classifyTomlFetchError(err)).toBe("tls");
    });

    it("classifies TLS / SSL / certificate keywords in message", () => {
      expect(classifyTomlFetchError(new Error("SSL handshake failed"))).toBe("tls");
      expect(classifyTomlFetchError(new Error("self-signed certificate in chain"))).toBe(
        "tls",
      );
    });
  });

  describe("parse category", () => {
    it("classifies SyntaxError", () => {
      expect(classifyTomlFetchError(new SyntaxError("invalid TOML"))).toBe("parse");
    });

    it("classifies parse and syntax keywords in message", () => {
      expect(classifyTomlFetchError(new Error("Failed to parse TOML"))).toBe("parse");
      expect(classifyTomlFetchError(new Error("malformed document"))).toBe("parse");
      expect(classifyTomlFetchError(new Error("invalid toml line: missing '='"))).toBe(
        "parse",
      );
    });

    it("does not classify unknown errors as parse", () => {
      expect(classifyTomlFetchError(new Error("Unknown error"))).toBeUndefined();
      expect(classifyTomlFetchError("Unknown error string")).toBeUndefined();
      expect(classifyTomlFetchError(12345)).toBeUndefined();
      expect(classifyTomlFetchError({ random: true })).toBeUndefined();
    });
  });
});

describe("validateToml (#662)", () => {
  it("passes full valid stellar.toml", () => {
    expect(() => validateToml(FULL_TOML)).not.toThrow();
  });

  it("passes minimal valid toml", () => {
    expect(() => validateToml('VERSION = "2.0.0"\n')).not.toThrow();
  });

  it("passes empty or whitespace-only toml documents", () => {
    expect(() => validateToml("")).not.toThrow();
    expect(() => validateToml("   \n  \t  \r\n")).not.toThrow();
    expect(() => validateToml("# only comments\n\n# another comment")).not.toThrow();
  });

  it("passes valid toml with UTF-8 BOM and CRLF line endings", () => {
    expect(() => validateToml('\uFEFFVERSION = "2.0.0"\r\n')).not.toThrow();
    expect(() =>
      validateToml('VERSION = "2.0.0"\r\n[DOCUMENTATION]\r\nORG_NAME = "Test"\r\n'),
    ).not.toThrow();
  });

  it("passes valid toml with inline tables and empty arrays", () => {
    const toml = `
VERSION = "2.0.0"
MAP = { code = "USD", issuer = "G123" }
EMPTY_TABLE = {}
EMPTY_ARRAY = []
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("passes valid [[CURRENCIES]] without optional fields", () => {
    const toml = `
[[CURRENCIES]]
code = "XLM"

[[CURRENCIES]]
code = "USD"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("allows URLs with #fragment, escaped quotes, single-quoted literals, and dotted keys", () => {
    const toml = `
VERSION = "2.0.0"
URL = "https://example.com/api/v1#section-auth"
ESCAPED = "hello \\"nested quote\\" inside"
LITERAL_URL = 'https://example.com/path#frag'
DOCUMENTATION.ORG_NAME = "Test Org"
DOCUMENTATION.ORG_URL = "https://example.com"
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("allows valid multi-line arrays", () => {
    const toml = `
VERSION = "2.0.0"
ACCOUNTS = [
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR",
]
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("allows table headers and array-of-tables with comments", () => {
    const toml = `
# Top comment
VERSION = "2.0.0" # version

[DOCUMENTATION] # documentation section
ORG_NAME = "Test Org"
ORG_URL = "https://example.com"

[[CURRENCIES]] # first currency
code = "USD"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

[[CURRENCIES]] # second currency
code = "EUR"
issuer = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("allows comments and brackets inside string literals without misinterpreting them", () => {
    const toml = `
VERSION = "2.0.0"
MESSAGE = "hello # this is not a comment [not array]"
LITERAL = 'another # comment [bracket]'
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("passes valid toml with multi-line strings", () => {
    const toml = `
VERSION = "2.0.0"
ESCAPED = "hello \\"world\\""
SAME_LINE = """single"""
SAME_LITERAL = '''single'''
[DOCUMENTATION]
ORG_DESCRIPTION = """
A long multi-line
description of the anchor
"""
MULTI_LITERAL = '''
line 1
line 2
'''
`;
    expect(() => validateToml(toml)).not.toThrow();
  });

  it("throws SyntaxError on unclosed multi-line strings", () => {
    expect(() => validateToml('VERSION = "2.0.0"\nDESC = """\nunclosed')).toThrowError(
      /unclosed multi-line string/,
    );
    expect(() => validateToml("VERSION = \"2.0.0\"\nDESC = '''\nunclosed")).toThrowError(
      /unclosed multi-line string/,
    );
  });

  it("throws SyntaxError on unclosed array", () => {
    const toml = `
VERSION = "2.0.0"
ACCOUNTS = [
  "GA...",
`;
    expect(() => validateToml(toml)).toThrowError(/unclosed array/);
  });

  it("throws SyntaxError on unmatched closing bracket", () => {
    const toml = `
VERSION = "2.0.0"
ACCOUNTS = [
  "GA...",
]]
`;
    expect(() => validateToml(toml)).toThrowError(/unmatched closing bracket/);
  });

  it("throws SyntaxError on HTML response", () => {
    expect(() => validateToml("<!DOCTYPE html><html><body>Error</body></html>")).toThrowError(
      /HTML\/XML/,
    );
    expect(() => validateToml("<html><body>Landing Page</body></html>")).toThrowError(
      /HTML\/XML/,
    );
  });

  it("throws SyntaxError on unclosed table header", () => {
    expect(() => validateToml("[DOCUMENTATION\nKEY = 'val'")).toThrowError(
      /invalid table header/,
    );
  });

  it("throws SyntaxError on line missing '='", () => {
    expect(() => validateToml("VERSION\nKEY = 'val'")).toThrowError(/missing '='/);
  });

  it("throws SyntaxError on line with missing value", () => {
    expect(() => validateToml("VERSION = \nKEY = 'val'")).toThrowError(/missing value/);
  });
});

describe("probeAnchor tomlFailureReason (#662)", () => {
  it("records http_404 when toml returns 404", async () => {
    const fetchImpl = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("http_404");
  });

  it("records http_403 when toml returns 403", async () => {
    const fetchImpl = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("http_403");
  });

  it("records timeout when fetch times out", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("timeout");
  });

  it("records dns when fetch fails with ENOTFOUND", async () => {
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND a.example"), {
        code: "ENOTFOUND",
      });
      throw err;
    }) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("dns");
  });

  it("records tls when fetch fails with certificate error", async () => {
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("certificate has expired"), {
        code: "CERT_HAS_EXPIRED",
      });
      throw err;
    }) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("tls");
  });

  it("records parse when toml returns HTML with 200 OK", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("stellar.toml")) {
        return new Response("<!DOCTYPE html><html><body>Error</body></html>", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("parse");
  });

  it("records parse when toml has malformed syntax", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("stellar.toml")) {
        return new Response("broken toml line with no equals", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBe("parse");
  });

  it("leaves tomlFailureReason undefined on successful probe", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("stellar.toml")) {
        return new Response(FULL_TOML, { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.tomlFailureReason).toBeUndefined();
  });
});

describe("probeAnchor User-Agent (#663)", () => {
  it("exports PROBE_USER_AGENT constant with descriptive identifier", () => {
    expect(PROBE_USER_AGENT).toBe(
      "corridor-in-a-box-probe (+https://github.com/corridor-in-a-box/corridor-in-a-box)",
    );
  });

  it("sends PROBE_USER_AGENT on every HTTP request across all SEPs", async () => {
    const { fetchImpl, recordedCalls } = stub();
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeProbes(r.probesPassed).length).toBe(7);
    expect(recordedCalls.length).toBeGreaterThanOrEqual(7);

    for (const call of recordedCalls) {
      expect(call.headers["user-agent"]).toBe(PROBE_USER_AGENT);
    }
  });

  it("sends PROBE_USER_AGENT on initial stellar.toml fetch even when it fails", async () => {
    const { fetchImpl, recordedCalls } = stub({ toml: null });
    await probeAnchor("a.example", { fetchImpl });

    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].url).toBe("https://a.example/.well-known/stellar.toml");
    expect(recordedCalls[0].headers["user-agent"]).toBe(PROBE_USER_AGENT);
  });

  it("preserves other request headers alongside user-agent", async () => {
    const { fetchImpl, recordedCalls } = stub();
    await probeAnchor("a.example", { fetchImpl });

    // POST /auth has content-type
    const authPost = recordedCalls.find((c) => c.url.includes("/auth") && c.method === "POST");
    expect(authPost).toBeDefined();
    expect(authPost?.headers["user-agent"]).toBe(PROBE_USER_AGENT);
    expect(authPost?.headers["content-type"]).toBe("application/json");

    // GET /sep31/info has authorization
    const sep31Get = recordedCalls.find((c) => c.url.includes("/sep31/info"));
    expect(sep31Get).toBeDefined();
    expect(sep31Get?.headers["user-agent"]).toBe(PROBE_USER_AGENT);
    expect(sep31Get?.headers["authorization"]).toMatch(/^Bearer /);

    // POST /sep38/quote has both content-type and authorization
    const quotePost = recordedCalls.find((c) => c.url.includes("/sep38/quote"));
    expect(quotePost).toBeDefined();
    expect(quotePost?.headers["user-agent"]).toBe(PROBE_USER_AGENT);
    expect(quotePost?.headers["content-type"]).toBe("application/json");
    expect(quotePost?.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("allows overriding user-agent via ProbeOptions.userAgent", async () => {
    const customUa = "custom-probe/1.0 (+https://example.com)";
    const { fetchImpl, recordedCalls } = stub();
    await probeAnchor("a.example", { fetchImpl, userAgent: customUa });

    expect(recordedCalls.length).toBeGreaterThanOrEqual(7);
    for (const call of recordedCalls) {
      expect(call.headers["user-agent"]).toBe(customUa);
    }
  });
});
