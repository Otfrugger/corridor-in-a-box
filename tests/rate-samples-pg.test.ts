import { describe, expect, it } from "vitest";
import {
  RATE_HISTORY_MIGRATION_SQL,
  CREATE_RATE_SAMPLES_TABLE_SQL,
  CREATE_RATE_DAILY_SUMMARIES_TABLE_SQL,
  PostgresRateHistoryStore,
  migrate,
  type Queryable,
  type RateDailySummary,
  type RateSampleInput,
} from "@corridor/engine";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function fakeDb(rows: Record<string, unknown>[] = [{ id: "1" }]) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Queryable = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows: rows as R[] };
    },
  };
  return { db, calls };
}

const sample = (over: Partial<RateSampleInput> = {}): RateSampleInput => ({
  network: "public",
  sellAsset: USDC,
  buyAsset: "iso4217:BRL",
  source: "own_payment",
  anchorDomain: "ntokens.com",
  rate: "5.4512345678901234",
  sampledAt: 1700000000000,
  runId: "run_test_123",
  detail: { note: "completed payment rate" },
  ...over,
});

const summary = (over: Partial<RateDailySummary> = {}): RateDailySummary => ({
  network: "public",
  sellAsset: USDC,
  buyAsset: "iso4217:BRL",
  source: "sep38_price",
  anchorDomain: "ntokens.com",
  day: "2026-11-19",
  sampleCount: 96,
  outlierCount: 1,
  minRate: "5.40",
  p25Rate: "5.42",
  medianRate: "5.45",
  p75Rate: "5.47",
  maxRate: "5.5",
  ...over,
});

describe("PostgresRateHistoryStore.record", () => {
  it("records the rate as the exact decimal string it was given, never a float", async () => {
    const { db, calls } = fakeDb();
    expect(await new PostgresRateHistoryStore(db).record(sample())).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/insert into rate_samples/);
    expect(calls[0]!.text).toMatch(/on conflict do nothing/);
    expect(calls[0]!.params).toEqual([
      "public",
      USDC,
      "iso4217:BRL",
      "own_payment",
      "ntokens.com",
      "5.4512345678901234",
      new Date(1700000000000).toISOString(),
      "run_test_123",
      false,
      JSON.stringify({ note: "completed payment rate" }),
    ]);
  });

  it("reports a duplicate (nothing returned by the insert) as false", async () => {
    const { db } = fakeDb([]);
    expect(await new PostgresRateHistoryStore(db).record(sample())).toBe(false);
  });

  it("stores null anchor, run and detail for a DEX trade", async () => {
    const { db, calls } = fakeDb();
    await new PostgresRateHistoryStore(db).record({
      network: "testnet",
      sellAsset: USDC,
      buyAsset: "stellar:native",
      source: "dex_trade",
      rate: "8.5000000",
      sampledAt: new Date("2026-11-19T12:00:00Z"),
      detail: { tradeCount: 4 },
    });
    expect(calls[0]!.params?.[4]).toBeNull();
    expect(calls[0]!.params?.[7]).toBeNull();
    expect(calls[0]!.params?.[9]).toBe(JSON.stringify({ tradeCount: 4 }));
  });

  it.each([
    ["a JS number", { rate: 5.45 as unknown as string }, /rate/],
    ["an exponent", { rate: "5e2" }, /rate/],
    ["a negative rate", { rate: "-1.2" }, /rate/],
    ["a zero rate", { rate: "0.000" }, /rate/],
    ["an empty rate", { rate: "" }, /rate/],
    ["an unknown source", { source: "guess" as RateSampleInput["source"] }, /source/],
    ["an invalid time", { sampledAt: "not a date" }, /sampledAt/],
    ["mainnet spelled pubnet", { network: "pubnet" as RateSampleInput["network"] }, /network/],
    ["a bare asset code", { sellAsset: "USDC" }, /sellAsset/],
    ["the same asset on both sides", { buyAsset: USDC }, /differ/],
    ["an anchor sample with no domain", { anchorDomain: null }, /anchorDomain/],
    ["a domain with a scheme", { anchorDomain: "https://ntokens.com" }, /anchorDomain/],
    ["an own payment with no run", { runId: null }, /runId/],
    [
      "a DEX trade naming an anchor",
      { source: "dex_trade" as const, runId: null, anchorDomain: "ntokens.com" },
      /anchorDomain/,
    ],
    [
      "a SEP-38 price naming a payment run",
      { source: "sep38_price" as const, runId: "run_1" },
      /runId/,
    ],
  ])("rejects %s without querying", async (_label, over, message) => {
    const { db, calls } = fakeDb();
    await expect(new PostgresRateHistoryStore(db).record(sample(over))).rejects.toThrow(
      message,
    );
    expect(calls).toHaveLength(0);
  });

  it("accepts a local reference anchor with a port", async () => {
    const { db } = fakeDb();
    await expect(
      new PostgresRateHistoryStore(db).record(
        sample({ network: "testnet", anchorDomain: "localhost:8080" }),
      ),
    ).resolves.toBe(true);
  });
});

describe("PostgresRateHistoryStore.list", () => {
  it("lists one series over a window, newest first", async () => {
    const { db, calls } = fakeDb([
      {
        id: 1,
        network: "public",
        sell_asset: USDC,
        buy_asset: "iso4217:BRL",
        source: "sep38_price",
        anchor_domain: "ntokens.com",
        rate: "5.5000000",
        sampled_at: new Date("2026-11-19T12:00:00Z"),
        run_id: null,
        outlier: false,
        detail: null,
      },
    ]);

    const results = await new PostgresRateHistoryStore(db).list({
      network: "public",
      sellAsset: USDC,
      buyAsset: "iso4217:BRL",
      source: "sep38_price",
      anchorDomain: "ntokens.com",
      since: 1700000000000,
      excludeOutliers: true,
      limit: 50,
    });

    expect(calls[0]!.text).toMatch(
      /where network = \$1 and sell_asset = \$2 and buy_asset = \$3 and source = \$4 and anchor_domain = \$5 and sampled_at >= \$6 and not outlier/,
    );
    expect(calls[0]!.text).toMatch(/rate::text as rate/);
    expect(calls[0]!.text).toMatch(/order by sampled_at desc/);
    expect(calls[0]!.text).toMatch(/limit 50/);
    expect(results).toEqual([
      {
        id: "1",
        network: "public",
        sellAsset: USDC,
        buyAsset: "iso4217:BRL",
        source: "sep38_price",
        anchorDomain: "ntokens.com",
        rate: "5.5000000",
        sampledAt: Date.parse("2026-11-19T12:00:00Z"),
        runId: null,
        outlier: false,
        detail: null,
      },
    ]);
  });

  it("rejects a limit that is not a positive integer", async () => {
    const { db } = fakeDb();
    await expect(new PostgresRateHistoryStore(db).list({ limit: 0 })).rejects.toThrow(/limit/);
  });
});

describe("PostgresRateHistoryStore daily summaries", () => {
  it("upserts one series' day with exact decimal strings", async () => {
    const { db, calls } = fakeDb();
    await new PostgresRateHistoryStore(db).upsertDailySummary(summary());
    expect(calls[0]!.text).toMatch(/insert into rate_daily_summaries/);
    expect(calls[0]!.text).toMatch(
      /on conflict \(network, sell_asset, buy_asset, source, anchor_domain, day\) do update/,
    );
    expect(calls[0]!.params).toEqual([
      "public",
      USDC,
      "iso4217:BRL",
      "sep38_price",
      "ntokens.com",
      "2026-11-19",
      96,
      1,
      "5.40",
      "5.42",
      "5.45",
      "5.47",
      "5.5",
    ]);
  });

  it("accepts a day whose samples were all outliers, with null rates", async () => {
    const { db, calls } = fakeDb();
    await new PostgresRateHistoryStore(db).upsertDailySummary(
      summary({
        sampleCount: 0,
        outlierCount: 3,
        minRate: null,
        p25Rate: null,
        medianRate: null,
        p75Rate: null,
        maxRate: null,
      }),
    );
    expect(calls[0]!.params?.slice(6)).toEqual([0, 3, null, null, null, null, null]);
  });

  it.each([
    ["an impossible day", { day: "2026-02-30" }, /day/],
    ["a day with a time", { day: "2026-11-19T00:00:00Z" }, /day/],
    ["unordered rates", { p25Rate: "5.39" }, /ordered/],
    ["a float rate", { medianRate: 5.45 as unknown as string }, /decimal/],
    ["rates on an empty day", { sampleCount: 0 }, /zero samples/],
    ["a fractional count", { sampleCount: 1.5 }, /sampleCount/],
  ])("rejects %s without querying", async (_label, over, message) => {
    const { db, calls } = fakeDb();
    await expect(
      new PostgresRateHistoryStore(db).upsertDailySummary(summary(over)),
    ).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("lists summaries oldest day first, with days as YYYY-MM-DD strings", async () => {
    const { db, calls } = fakeDb([
      {
        network: "public",
        sell_asset: USDC,
        buy_asset: "iso4217:BRL",
        source: "sep38_price",
        anchor_domain: "ntokens.com",
        day: "2026-11-19",
        sample_count: 96,
        outlier_count: 1,
        min_rate: "5.40",
        p25_rate: "5.42",
        median_rate: "5.45",
        p75_rate: "5.47",
        max_rate: "5.5",
        computed_at: new Date("2026-11-20T00:05:00Z"),
      },
    ]);
    const rows = await new PostgresRateHistoryStore(db).listDailySummaries({
      network: "public",
      fromDay: "2026-11-01",
      toDay: "2026-11-30",
    });
    expect(calls[0]!.text).toMatch(/where network = \$1 and day >= \$2 and day <= \$3/);
    expect(calls[0]!.text).toMatch(/to_char\(day, 'YYYY-MM-DD'\)/);
    expect(rows[0]).toMatchObject({ day: "2026-11-19", sampleCount: 96, p25Rate: "5.42" });
    expect(rows[0]!.computedAt).toBe(Date.parse("2026-11-20T00:05:00Z"));
  });
});

describe("rate history migration", () => {
  it("is part of migrate(), in order", async () => {
    const { db, calls } = fakeDb();
    await migrate(db);
    const sql = calls.map((c) => c.text);
    const at = RATE_HISTORY_MIGRATION_SQL.map((s) => sql.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("stores every rate as numeric, never a float type", () => {
    for (const ddl of [CREATE_RATE_SAMPLES_TABLE_SQL, CREATE_RATE_DAILY_SUMMARIES_TABLE_SQL]) {
      expect(ddl).not.toMatch(/\b(real|double precision|float\d?)\b/);
    }
    expect(CREATE_RATE_SAMPLES_TABLE_SQL).toMatch(/rate\s+numeric not null/);
    expect(CREATE_RATE_SAMPLES_TABLE_SQL).toMatch(/sampled_at\s+timestamptz not null/);
  });

  it("keys samples by series and instant so a re-read stores nothing twice", () => {
    expect(RATE_HISTORY_MIGRATION_SQL.join("\n")).toMatch(
      /unique index if not exists rate_samples_series_key on rate_samples \(network, sell_asset, buy_asset, source, anchor_domain, sampled_at desc, run_id\) nulls not distinct/,
    );
  });
});
