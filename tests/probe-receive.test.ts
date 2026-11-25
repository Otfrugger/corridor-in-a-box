// The SEP-31 receive list with its amount bounds, as the probe records it.
//
// A bound goes on chain as an integer on a fixed scale, so most of what is tested
// here is what is NOT recorded: anything that would have to be rounded, repaired
// or guessed at is left out, and the registry then says "no bound was observed",
// which is true.

import { describe, expect, it } from "vitest";
import {
  describeReceiveLimits,
  formatProbeResultJson,
  parseProbeResults,
  parseReceiveLimits,
  probeAnchor,
  probeBit,
  receiveBound,
  receiveLimitsFrom,
  renderSweepJson,
  type ProbeResult,
  type ReceiveAssetLimits,
} from "@corridor/probe";

describe("receiveBound: a JSON number", () => {
  it("is written as the decimal the anchor wrote", () => {
    expect(receiveBound(1000)).toBe("1000");
    expect(receiveBound(0.1)).toBe("0.1");
    expect(receiveBound(0.5)).toBe("0.5");
    expect(receiveBound(12.75)).toBe("12.75");
    expect(receiveBound(5_000_000)).toBe("5000000");
    expect(receiveBound(12345678.1234567)).toBe("12345678.1234567");
  });

  it("keeps a stated zero, which is not the same as stating nothing", () => {
    expect(receiveBound(0)).toBe("0");
    expect(receiveBound(-0)).toBe("0");
  });

  it("undoes the exponent a small or a large number is printed with", () => {
    expect(String(1e-7)).toBe("1e-7");
    expect(receiveBound(1e-7)).toBe("0.0000001");
    expect(receiveBound(2.5e-6)).toBe("0.0000025");
    expect(String(1e21)).toBe("1e+21");
    expect(receiveBound(1e21)).toBe("1000000000000000000000");
    expect(receiveBound(1.5e22)).toBe("15000000000000000000000");
  });

  it("refuses more than seven decimal places instead of rounding", () => {
    expect(receiveBound(1e-8)).toBeUndefined();
    expect(receiveBound(0.12345678)).toBeUndefined();
    expect(receiveBound(1.00000001)).toBeUndefined();
    // Seven is the limit, and it is fine.
    expect(receiveBound(0.1234567)).toBe("0.1234567");
  });

  it("refuses a number with more digits than a double keeps", () => {
    // 0.1 + 0.2: the digits printed are the double's, not anything an anchor wrote.
    expect(receiveBound(0.1 + 0.2)).toBeUndefined();
    // Sixteen significant digits: past what survives the trip through a float.
    expect(receiveBound(123456789.1234567)).toBeUndefined();
    // The way it would arrive. JSON.parse reads this literal as ...992, a number
    // the anchor never wrote, and nothing downstream could tell.
    const parsed: unknown = JSON.parse("9007199254740993");
    expect(parsed).toBe(2 ** 53);
    expect(receiveBound(parsed)).toBeUndefined();
    // Fifteen is kept.
    expect(receiveBound(123456789012345)).toBe("123456789012345");
  });

  it("refuses a negative, and anything that is not a finite number", () => {
    expect(receiveBound(-1)).toBeUndefined();
    expect(receiveBound(-0.0000001)).toBeUndefined();
    expect(receiveBound(Number.NaN)).toBeUndefined();
    expect(receiveBound(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(receiveBound(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });
});

describe("receiveBound: a decimal string", () => {
  it("is accepted and put in canonical form", () => {
    expect(receiveBound("1000")).toBe("1000");
    expect(receiveBound("0.10")).toBe("0.1");
    expect(receiveBound(" 5 ")).toBe("5");
    expect(receiveBound("007.5000000")).toBe("7.5");
    expect(receiveBound("0")).toBe("0");
    // A string is not limited to the digits of a double.
    expect(receiveBound("123456789012345678.1234567")).toBe("123456789012345678.1234567");
  });

  it("refuses anything that is not plain digits with at most one point", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "1e3",
      "-1",
      "+1",
      // A signed zero is still a sign: the value is fine, the spelling is not.
      "-0",
      "-0.0",
      "+0",
      "1.",
      ".5",
      "1,000",
      "1 000",
      "0x10",
      "1.2.3",
      "NaN",
      "Infinity",
    ]) {
      expect(receiveBound(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("refuses more than seven decimal places", () => {
    expect(receiveBound("0.12345678")).toBeUndefined();
    expect(receiveBound("0.00000001")).toBeUndefined();
    expect(receiveBound("0.1234567")).toBe("0.1234567");
  });

  it("accepts the largest amount the contract can hold and nothing above it", () => {
    // i128::MAX on the 10^7 scale, and one stroop more.
    expect(receiveBound("17014118346046923173168730371588.4105727")).toBe(
      "17014118346046923173168730371588.4105727",
    );
    expect(receiveBound("17014118346046923173168730371588.4105728")).toBeUndefined();
    expect(receiveBound("1" + "0".repeat(40))).toBeUndefined();
  });
});

describe("receiveBound: anything else", () => {
  it("is not a bound", () => {
    for (const other of [undefined, null, true, false, {}, [], [1], { amount: 1 }, 10n]) {
      expect(receiveBound(other), String(other)).toBeUndefined();
    }
  });
});

describe("receiveLimitsFrom", () => {
  it("reads each asset's bounds, in the order the response listed them", () => {
    const limits = receiveLimitsFrom({
      NGN: { min_amount: 1000, max_amount: 5_000_000, fee_fixed: 5, sep12: {} },
      USDC: { min_amount: 0.1 },
      KES: {},
      "iso4217:XOF": { max_amount: "250000.50" },
    });

    expect(limits).toStrictEqual<ReceiveAssetLimits[]>([
      { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
      { code: "USDC", minAmount: "0.1" },
      { code: "KES" },
      { code: "iso4217:XOF", maxAmount: "250000.5" },
    ]);
  });

  it("keeps the asset and drops only the bound it cannot record", () => {
    const limits = receiveLimitsFrom({
      NGN: { min_amount: -5, max_amount: 1000 },
      KES: { min_amount: 0.123456789, max_amount: null },
      GHS: { min_amount: "ten", max_amount: {} },
    });

    // The anchor still receives all three. What is missing is a number that
    // could be written down exactly, and a missing key says so.
    expect(limits).toStrictEqual<ReceiveAssetLimits[]>([
      { code: "NGN", maxAmount: "1000" },
      { code: "KES" },
      { code: "GHS" },
    ]);
  });

  it("lists an asset whose entry is not an object, with no bounds", () => {
    expect(receiveLimitsFrom({ NGN: null, KES: true, GHS: "enabled", XOF: 7 })).toStrictEqual([
      { code: "NGN" },
      { code: "KES" },
      { code: "GHS" },
      { code: "XOF" },
    ]);
  });

  it("stores a minimum above the maximum as it was stated", () => {
    expect(receiveLimitsFrom({ NGN: { min_amount: 100, max_amount: 10 } })).toStrictEqual([
      { code: "NGN", minAmount: "100", maxAmount: "10" },
    ]);
  });

  it("is empty for an empty receive object", () => {
    expect(receiveLimitsFrom({})).toEqual([]);
  });
});

describe("describeReceiveLimits", () => {
  it("says which bounds were stated, and says when none were", () => {
    expect(
      describeReceiveLimits([
        { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
        { code: "USDC", minAmount: "0.1" },
        { code: "XOF", maxAmount: "250000.5" },
        { code: "KES" },
      ]),
    ).toBe("NGN 1000 to 5000000, USDC from 0.1, XOF up to 250000.5, KES (no bounds stated)");
  });

  it("names an empty list for what it is", () => {
    expect(describeReceiveLimits([])).toBe("no receivable assets");
  });
});

describe("parseReceiveLimits", () => {
  it("accepts a stored list and puts its amounts in canonical form", () => {
    expect(
      parseReceiveLimits(
        [{ code: "NGN", minAmount: "1000.00", maxAmount: "5000000" }, { code: "KES" }],
        "a.example",
      ),
    ).toStrictEqual([
      { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
      { code: "KES" },
    ]);
  });

  it("refuses a list that was not written by the probe", () => {
    const refused = (raw: unknown, why: string) =>
      expect(() => parseReceiveLimits(raw, "a.example"), why).toThrow(
        `Probe result for a.example has an invalid receiveLimits list (${why}`,
      );

    refused("NGN", "expected an array");
    refused({ NGN: {} }, "expected an array");
    refused(["NGN"], "entry 0 is not an object");
    refused([{ code: "NGN" }, null], "entry 1 is not an object");
    refused([{ minAmount: "1" }], "entry 0 has no asset code");
    refused([{ code: "" }], "entry 0 has no asset code");
    refused([{ code: "NGN", minAmount: "-5" }], "NGN minAmount must be");
    refused([{ code: "NGN", maxAmount: "0.12345678" }], "NGN maxAmount must be");
    refused([{ code: "NGN", maxAmount: "1e3" }], "NGN maxAmount must be");
    // A number is what `/info` sends, not what a stored result holds: the probe
    // has already turned it into a string, and a float here was typed in.
    refused([{ code: "NGN", minAmount: 1000 }], "NGN minAmount must be");
    refused([{ code: "NGN", minAmount: null }], "NGN minAmount must be");
  });
});

const SEP31_ONLY_TOML = `
VERSION = "2.0.0"
DIRECT_PAYMENT_SERVER = "https://a.example/sep31"
`;

/** An anchor that serves only SEP-1 and SEP-31, answering `/info` with `info`. */
function anchor(info: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/.well-known/stellar.toml")) {
      return new Response(SEP31_ONLY_TOML, { status: 200 });
    }
    if (u === "https://a.example/sep31/info") {
      return new Response(JSON.stringify(info), { status });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const INFO = {
  receive: {
    NGN: { enabled: true, min_amount: 1000, max_amount: 5_000_000, fee_percent: 1 },
    USDC: { enabled: true, min_amount: 0.1 },
    KES: { enabled: true },
  },
};

describe("probeAnchor: the receive list with its bounds", () => {
  it("records the bounds from the same response as the asset list", async () => {
    const { fetchImpl, calls } = anchor(INFO);

    const r = await probeAnchor("a.example", { fetchImpl });

    expect(r.probesPassed & probeBit("sep31_info")).not.toBe(0);
    expect(r.sep31ReceiveAssets).toEqual(["NGN", "USDC", "KES"]);
    expect(r.receiveLimits).toStrictEqual([
      { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
      { code: "USDC", minAmount: "0.1" },
      { code: "KES" },
    ]);
    // One list, one observation: the codes are the codes, in the same order.
    expect(r.receiveLimits?.map((l) => l.code)).toEqual(r.sep31ReceiveAssets);
    // And one request for it, not a second call for the limits.
    expect(calls.filter((u) => u.endsWith("/sep31/info"))).toHaveLength(1);
  });

  it("records no list at all when the anchor lists nothing", async () => {
    const { fetchImpl } = anchor({ receive: {} });

    const r = await probeAnchor("a.example", { fetchImpl });

    expect(r.probesRun & probeBit("sep31_info")).not.toBe(0);
    expect(r.probesPassed & probeBit("sep31_info")).toBe(0);
    expect(r.sep31ReceiveAssets).toBeUndefined();
    expect(r.receiveLimits).toBeUndefined();
    expect("receiveLimits" in r).toBe(false);
  });

  it("records no list when /info could not be read", async () => {
    const { fetchImpl } = anchor({}, 503);

    const r = await probeAnchor("a.example", { fetchImpl });

    expect(r.probesPassed & probeBit("sep31_info")).toBe(0);
    expect(r.receiveLimits).toBeUndefined();
  });

  it("does not change the probe's one-line detail", async () => {
    const { fetchImpl } = anchor(INFO);

    const r = await probeAnchor("a.example", { fetchImpl });

    expect(r.outcomes.find((o) => o.probe === "sep31_info")?.detail).toBe(
      "receives NGN, USDC, KES",
    );
  });
});

describe("the receive list on its way from a sweep to an attestation", () => {
  const SEP31_RAN = probeBit("toml_fetch") | probeBit("sep31_info");
  const stored: ProbeResult = {
    domain: "a.example",
    seps: 0b1 | 0b100000,
    probesRun: SEP31_RAN,
    probesPassed: SEP31_RAN,
    tomlHash: "ab".repeat(32),
    outcomes: [],
    receiveAssets: ["NGN", "KES"],
    sep31ReceiveAssets: ["NGN", "KES"],
    receiveLimits: [{ code: "NGN", minAmount: "1000", maxAmount: "5000000" }, { code: "KES" }],
  };

  it("survives sweep.json, which is what `pnpm attest --from` reads", () => {
    const [back] = parseProbeResults(renderSweepJson([stored]));

    expect(back.receiveLimits).toStrictEqual(stored.receiveLimits);
    expect(back.receiveAssets).toEqual(["NGN", "KES"]);
  });

  it("survives the --json output of probe:anchor", () => {
    const [back] = parseProbeResults(formatProbeResultJson(stored));

    expect(back.receiveLimits).toStrictEqual(stored.receiveLimits);
  });

  it("stays absent for a result stored before limits were recorded", () => {
    const { receiveLimits: _dropped, ...older } = stored;

    const [back] = parseProbeResults(JSON.stringify([older]));

    expect(back.receiveAssets).toEqual(["NGN", "KES"]);
    expect("receiveLimits" in back).toBe(false);
  });

  it("refuses a stored list whose bound was edited into something else", () => {
    const edited = {
      ...stored,
      receiveLimits: [{ code: "NGN", minAmount: "-1" }],
    };

    expect(() => parseProbeResults(JSON.stringify([edited]))).toThrow(
      "Probe result for a.example has an invalid receiveLimits list",
    );
  });
});
