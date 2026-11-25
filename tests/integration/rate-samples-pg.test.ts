// Integration test for the rate history schema and PostgresRateHistoryStore against a REAL
// Postgres (#589).
//
// tests/rate-samples-pg.test.ts checks the SQL the store sends. This file runs it: the check
// constraints, the `nulls not distinct` unique keys that make a collector re-read a no-op, and
// the numeric round trip, none of which a fake can prove.
//
// Opt-in, like audit-pg.test.ts and breaker-pg.test.ts: skipped unless
// CORRIDOR_TEST_DATABASE_URL is set. CI provides a Postgres service container
// (.github/workflows/ci.yml). Locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/rate-samples-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresRateHistoryStore,
  migrate,
  type Queryable,
  type RateSampleInput,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

run("Postgres rate history schema and store (live Postgres)", () => {
  let pool: { query: Queryable["query"]; end: () => Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as unknown as typeof pool;
    await migrate(pool as unknown as Queryable);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from rate_samples");
    await pool.query("delete from rate_daily_summaries");
  });

  const store = () => new PostgresRateHistoryStore(pool as unknown as Queryable);

  const sep38 = (over: Partial<RateSampleInput> = {}): RateSampleInput => ({
    network: "public",
    sellAsset: USDC,
    buyAsset: "iso4217:BRL",
    source: "sep38_price",
    anchorDomain: "ntokens.com",
    rate: "5.45",
    sampledAt: Date.parse("2026-11-19T10:00:00Z"),
    ...over,
  });

  it("migrate() is idempotent and leaves rates numeric and times timestamptz", async () => {
    await migrate(pool as unknown as Queryable);
    await migrate(pool as unknown as Queryable);

    const colRes = await pool.query(
      "select table_name, column_name, data_type from information_schema.columns where table_name in ($1, $2)",
      ["rate_samples", "rate_daily_summaries"],
    );
    const cols = Object.fromEntries(
      (
        colRes.rows as Array<{ table_name: string; column_name: string; data_type: string }>
      ).map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]),
    );
    expect(cols["rate_samples.rate"]).toBe("numeric");
    expect(cols["rate_samples.sampled_at"]).toBe("timestamp with time zone");
    expect(cols["rate_samples.outlier"]).toBe("boolean");
    for (const c of ["min_rate", "p25_rate", "median_rate", "p75_rate", "max_rate"]) {
      expect(cols[`rate_daily_summaries.${c}`]).toBe("numeric");
    }
    expect(cols["rate_daily_summaries.day"]).toBe("date");

    const idxRes = await pool.query(
      "select indexname from pg_indexes where tablename in ($1, $2)",
      ["rate_samples", "rate_daily_summaries"],
    );
    expect((idxRes.rows as Array<{ indexname: string }>).map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        "rate_samples_series_key",
        "rate_samples_run_key",
        "rate_samples_sampled_at_idx",
        "rate_daily_summaries_series_day_key",
        "rate_daily_summaries_day_idx",
      ]),
    );
  });

  it("round-trips a high-precision rate exactly", async () => {
    const preciseRate = "1650.1234567890123456789";
    await store().record({
      network: "public",
      sellAsset: USDC,
      buyAsset: "iso4217:NGN",
      source: "own_payment",
      anchorDomain: "cowrie.exchange",
      runId: "run_precise_1",
      rate: preciseRate,
      sampledAt: new Date("2026-11-19T14:30:00Z"),
    });

    const listed = await store().list({ sellAsset: USDC, buyAsset: "iso4217:NGN" });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      rate: preciseRate,
      anchorDomain: "cowrie.exchange",
      runId: "run_precise_1",
      outlier: false,
      sampledAt: Date.parse("2026-11-19T14:30:00Z"),
    });
  });

  it("stores a re-read sample once, for an anchor series and for an anchorless DEX series", async () => {
    expect(await store().record(sep38())).toBe(true);
    expect(await store().record(sep38({ rate: "5.46" }))).toBe(false);

    const dex: RateSampleInput = {
      network: "public",
      sellAsset: USDC,
      buyAsset: "stellar:native",
      source: "dex_trade",
      rate: "8.1",
      sampledAt: Date.parse("2026-11-19T10:00:00Z"),
      detail: { tradeCount: 3 },
    };
    // anchor_domain is null here: the key treats nulls as equal, so this is still a duplicate.
    expect(await store().record(dex)).toBe(true);
    expect(await store().record(dex)).toBe(false);

    // The same instant on another network or from another anchor is a different series.
    expect(await store().record(sep38({ network: "testnet" }))).toBe(true);
    expect(await store().record(sep38({ anchorDomain: "other.example" }))).toBe(true);

    const rows = await store().list();
    expect(rows).toHaveLength(4);
    expect(
      rows.find(
        (r) =>
          r.source === "sep38_price" &&
          r.network === "public" &&
          r.anchorDomain === "ntokens.com",
      )!.rate,
    ).toBe("5.45");
  });

  it("stores one own_payment sample per payment run", async () => {
    const own = sep38({ source: "own_payment", runId: "run_42" });
    expect(await store().record(own)).toBe(true);
    expect(
      await store().record({ ...own, sampledAt: Date.parse("2026-11-19T11:00:00Z") }),
    ).toBe(false);
    // Two different payments completing in the same millisecond are two samples.
    expect(await store().record({ ...own, runId: "run_43" })).toBe(true);
    expect(await store().list({ source: "own_payment" })).toHaveLength(2);
  });

  it("returns one series over a window, newest first, without the other network", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      await store().record(sep38({ rate: `5.4${i}0000`, sampledAt: t0 + i * 3_600_000 }));
    }
    await store().record(
      sep38({ network: "testnet", rate: "9.99", sampledAt: t0 + 7_200_000 }),
    );

    const window = await store().list({
      network: "public",
      sellAsset: USDC,
      buyAsset: "iso4217:BRL",
      source: "sep38_price",
      anchorDomain: "ntokens.com",
      since: t0 + 3_600_000,
      until: t0 + 3 * 3_600_000,
    });
    expect(window.map((w) => w.rate)).toEqual(["5.430000", "5.420000", "5.410000"]);
  });

  it("keeps outliers visible and leaves them out on request", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    await store().record(sep38({ sampledAt: t0 }));
    await store().record(sep38({ sampledAt: t0 + 1, rate: "54.5", outlier: true }));

    expect((await store().list()).map((r) => r.outlier)).toEqual([true, false]);
    expect((await store().list({ excludeOutliers: true })).map((r) => r.rate)).toEqual([
      "5.45",
    ]);
  });

  it("refuses rows that break the schema's rules, even bypassing the store", async () => {
    const insert = (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return pool.query(
        `insert into rate_samples (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(cols),
      );
    };
    const ok = {
      network: "public",
      sell_asset: USDC,
      buy_asset: "iso4217:BRL",
      source: "sep38_price",
      anchor_domain: "ntokens.com",
      rate: "1",
      sampled_at: "2026-11-19T10:00:00Z",
    };
    await expect(insert(ok)).resolves.toBeDefined();
    await expect(
      insert({ ...ok, rate: "0", sampled_at: "2026-11-19T10:00:01Z" }),
    ).rejects.toThrow();
    await expect(insert({ ...ok, source: "guess" })).rejects.toThrow();
    await expect(insert({ ...ok, network: "pubnet" })).rejects.toThrow();
    await expect(insert({ ...ok, buy_asset: USDC })).rejects.toThrow();
    await expect(insert({ ...ok, anchor_domain: null })).rejects.toThrow();
    await expect(insert({ ...ok, source: "dex_trade" })).rejects.toThrow();
    await expect(insert({ ...ok, source: "own_payment" })).rejects.toThrow();
  });

  it("upserts a daily summary and keeps network series apart", async () => {
    const day = {
      network: "public" as const,
      sellAsset: USDC,
      buyAsset: "iso4217:BRL",
      source: "dex_trade" as const,
      day: "2026-11-19",
      sampleCount: 90,
      outlierCount: 0,
      minRate: "5.40",
      p25Rate: "5.42",
      medianRate: "5.45",
      p75Rate: "5.47",
      maxRate: "5.50",
    };
    await store().upsertDailySummary(day);
    // A rerun of the day after a late sample replaces it; the null anchor still matches.
    await store().upsertDailySummary({ ...day, sampleCount: 91, maxRate: "5.51" });
    await store().upsertDailySummary({
      ...day,
      network: "testnet",
      medianRate: "9",
      p75Rate: "9",
      maxRate: "9",
    });
    // A day whose samples were all outliers is recorded as such.
    await store().upsertDailySummary({
      ...day,
      day: "2026-11-20",
      sampleCount: 0,
      outlierCount: 4,
      minRate: null,
      p25Rate: null,
      medianRate: null,
      p75Rate: null,
      maxRate: null,
    });

    const pub = await store().listDailySummaries({ network: "public" });
    expect(pub.map((s) => [s.day, s.sampleCount, s.maxRate, s.p25Rate])).toEqual([
      ["2026-11-19", 91, "5.51", "5.42"],
      ["2026-11-20", 0, null, null],
    ]);
    expect(await store().listDailySummaries({ network: "testnet" })).toHaveLength(1);

    await expect(
      pool.query(
        `insert into rate_daily_summaries (network, sell_asset, buy_asset, source, day, sample_count, min_rate, p25_rate, median_rate, p75_rate, max_rate)
         values ('public', $1, 'iso4217:BRL', 'dex_trade', '2026-11-21', 5, '5', '4', '5', '5', '5')`,
        [USDC],
      ),
    ).rejects.toThrow();
  });
});
