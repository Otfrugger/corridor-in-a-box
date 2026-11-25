import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  filterChoices,
  filterSearch,
  hasFilters,
  matchesFilters,
  parseFilters,
} from "../web/lib/anchor-filters";
import type { AnchorAttestation } from "../web/lib/registry";

function anchor(over: Partial<AnchorAttestation>): AnchorAttestation {
  return {
    domain: "example.com",
    seps: [1, 10],
    probesRun: ["toml_fetch"],
    probesPassed: ["toml_fetch"],
    tomlHash: "ab".repeat(32),
    attestedLedger: 1,
    attester: "G".padEnd(56, "A"),
    staleness: 0,
    servesSep31: false,
    ...over,
  };
}

const cowrie = anchor({
  domain: "cowrie.exchange",
  seps: [1, 10, 12, 31, 38],
  servesSep31: true,
  receiveAssets: ["USDC"],
  countries: ["NG"],
});
const ntokens = anchor({
  domain: "ntokens.com",
  seps: [1, 6, 10, 12, 24, 31],
  countries: ["BR"],
});
const bare = anchor({ domain: "lobstr.co" });
const all = [cowrie, ntokens, bare];

const pick = (search: string) =>
  all.filter((a) => matchesFilters(a, parseFilters(search))).map((a) => a.domain);

describe("web anchor filters", () => {
  it("shows every anchor with no filter", () => {
    expect(pick("")).toEqual(["cowrie.exchange", "ntokens.com", "lobstr.co"]);
    expect(hasFilters(parseFilters("?network=public"))).toBe(false);
  });

  it("keeps advertising SEP-31 apart from serving it", () => {
    expect(pick("?sep=31")).toEqual(["cowrie.exchange", "ntokens.com"]);
    expect(pick("?sep=31-served")).toEqual(["cowrie.exchange"]);
    expect(pick("?sep=24")).toEqual(["ntokens.com"]);
    expect(pick("?sep=nonsense")).toEqual([]);
  });

  it("filters by probed receive asset, declared country and domain text", () => {
    expect(pick("?asset=USDC")).toEqual(["cowrie.exchange"]);
    expect(pick("?country=br")).toEqual(["ntokens.com"]);
    expect(pick("?q=LOB")).toEqual(["lobstr.co"]);
    expect(pick("?asset=USDC&country=NG")).toEqual(["cowrie.exchange"]);
    expect(pick("?asset=USDC&country=BR")).toEqual([]);
  });

  it("writes filters into the URL without dropping the network", () => {
    const next = filterSearch("?network=public", {
      ...EMPTY_FILTERS,
      sep: "31",
      country: "NG",
    });
    expect(next).toBe("?network=public&sep=31&country=NG");
    expect(filterSearch(next, EMPTY_FILTERS)).toBe("?network=public");
    expect(filterSearch("?sep=31", EMPTY_FILTERS)).toBe("");
  });

  it("offers only the assets and countries the anchors have, sorted", () => {
    expect(filterChoices(all)).toEqual({ assets: ["USDC"], countries: ["BR", "NG"] });
  });
});
