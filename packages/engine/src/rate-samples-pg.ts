// Durable rate history backed by SQL (Postgres). RFC 0004 §3, issue #589.
//
// Rate samples record prices observed over time from four sources: an anchor's
// SEP-38 indicative price, a Stellar DEX trade, a public reference FX rate, and
// the effective rate of the business's own completed payments. The collectors
// write here; the planner reads a window back to build `estimated` prices; a
// daily job folds old samples into `rate_daily_summaries`, which are kept
// forever and published so anyone can check the numbers the router uses.
//
// A series is one (network, sell asset, buy asset, source, anchor domain). Every
// query and every summary stays inside one series, so testnet and mainnet prices
// never mix, and a DEX price never stands in for an anchor's own.
//
// Rates are stored as Postgres `numeric` and travel through this module as
// decimal strings. They are never parsed into a JS number, so no float rounding
// can creep in between the anchor's response and the stored value.
//
// Same tiny Queryable seam as idempotency-pg.ts; the tables are created by the
// shared, idempotent `migrate()` there. The unique keys use `NULLS NOT
// DISTINCT`, so they need Postgres 15 or later.

import type { Queryable } from "./idempotency-pg";

/** Where a sample came from. Mirrors the `source` check constraint below. */
export const RATE_SAMPLE_SOURCES = [
  "sep38_price",
  "dex_trade",
  "reference_fx",
  "own_payment",
] as const;
export type RateSampleSource = (typeof RATE_SAMPLE_SOURCES)[number];

/** Sources that are one anchor's price, so they carry its domain. The others never do. */
export const ANCHOR_RATE_SOURCES: readonly RateSampleSource[] = ["sep38_price", "own_payment"];

/** The Stellar network a price was seen on, named as `@corridor/stellar` names it. */
export const RATE_NETWORKS = ["testnet", "public"] as const;
export type RateNetwork = (typeof RATE_NETWORKS)[number];

const SOURCES_SQL = RATE_SAMPLE_SOURCES.map((s) => `'${s}'`).join(", ");
const ANCHOR_SOURCES_SQL = ANCHOR_RATE_SOURCES.map((s) => `'${s}'`).join(", ");
const NETWORKS_SQL = RATE_NETWORKS.map((n) => `'${n}'`).join(", ");

/**
 * One row per observed price.
 *
 * - `anchor_domain` is set exactly for the anchor sources (`sep38_price`, `own_payment`); a DEX
 *   trade or a reference rate belongs to no anchor.
 * - `run_id` is set exactly for `own_payment`: the payment run whose effective rate it is.
 * - `outlier` is set by the outlier pass (#602). A flagged sample is kept, visible, and left out
 *   of percentiles and summaries; samples are never deleted for being odd.
 * - `detail` holds what one source has and the others do not, e.g. a DEX bucket's trade count
 *   or the reference amount a SEP-38 price was asked for.
 */
export const CREATE_RATE_SAMPLES_TABLE_SQL = `
create table if not exists rate_samples (
  id            bigserial primary key,
  network       text not null check (network in (${NETWORKS_SQL})),
  sell_asset    text not null,
  buy_asset     text not null,
  source        text not null check (source in (${SOURCES_SQL})),
  anchor_domain text,
  rate          numeric not null check (rate > 0),
  sampled_at    timestamptz not null,
  run_id        text,
  outlier       boolean not null default false,
  detail        jsonb,
  recorded_at   timestamptz not null default now(),
  constraint rate_samples_distinct_assets check (sell_asset <> buy_asset),
  constraint rate_samples_anchor_domain_by_source
    check ((source in (${ANCHOR_SOURCES_SQL})) = (anchor_domain is not null)),
  constraint rate_samples_run_id_by_source
    check ((source = 'own_payment') = (run_id is not null))
);`;

/**
 * - `rate_samples_series_key`: one sample per series per instant, so a collector that re-reads
 *   an overlapping Horizon window or retries a SEP-38 poll stores nothing twice. Its column order
 *   is also the planner's read: one series over a time range, newest first.
 * - `rate_samples_run_key`: one `own_payment` sample per payment run.
 * - `rate_samples_sampled_at_idx`: retention and daily summaries read one day across every series.
 */
export const RATE_SAMPLES_INDEX_SQL = [
  `create unique index if not exists rate_samples_series_key on rate_samples (network, sell_asset, buy_asset, source, anchor_domain, sampled_at desc, run_id) nulls not distinct;`,
  `create unique index if not exists rate_samples_run_key on rate_samples (network, run_id) where run_id is not null;`,
  `create index if not exists rate_samples_sampled_at_idx on rate_samples (sampled_at);`,
];

/**
 * One row per series per UTC day (RFC 0004 §3: min, P25, median, P75, max, sample count).
 * Kept forever; raw samples older than the retention period are pruned only once their day's
 * summary row exists (#599). `sample_count` counts the samples the statistics were computed
 * from (outliers excluded); a day whose samples were all outliers still gets a row, with
 * `sample_count` 0 and null statistics, so "summarised, nothing usable" differs from "not yet
 * summarised".
 */
export const CREATE_RATE_DAILY_SUMMARIES_TABLE_SQL = `
create table if not exists rate_daily_summaries (
  network       text not null check (network in (${NETWORKS_SQL})),
  sell_asset    text not null,
  buy_asset     text not null,
  source        text not null check (source in (${SOURCES_SQL})),
  anchor_domain text,
  day           date not null,
  sample_count  integer not null check (sample_count >= 0),
  outlier_count integer not null default 0 check (outlier_count >= 0),
  min_rate      numeric,
  p25_rate      numeric,
  median_rate   numeric,
  p75_rate      numeric,
  max_rate      numeric,
  computed_at   timestamptz not null default now(),
  constraint rate_daily_summaries_anchor_domain_by_source
    check ((source in (${ANCHOR_SOURCES_SQL})) = (anchor_domain is not null)),
  constraint rate_daily_summaries_stats_present
    check (
      (sample_count = 0 and min_rate is null and p25_rate is null and median_rate is null
        and p75_rate is null and max_rate is null)
      or (sample_count > 0 and min_rate > 0 and min_rate <= p25_rate and p25_rate <= median_rate
        and median_rate <= p75_rate and p75_rate <= max_rate)
    )
);`;

export const RATE_DAILY_SUMMARIES_INDEX_SQL = [
  `create unique index if not exists rate_daily_summaries_series_day_key on rate_daily_summaries (network, sell_asset, buy_asset, source, anchor_domain, day) nulls not distinct;`,
  `create index if not exists rate_daily_summaries_day_idx on rate_daily_summaries (day);`,
];

/** Everything rate history needs, in order. `migrate()` runs it; each statement is idempotent. */
export const RATE_HISTORY_MIGRATION_SQL = [
  CREATE_RATE_SAMPLES_TABLE_SQL,
  ...RATE_SAMPLES_INDEX_SQL,
  CREATE_RATE_DAILY_SUMMARIES_TABLE_SQL,
  ...RATE_DAILY_SUMMARIES_INDEX_SQL,
];

/** Fields that name one series. */
export interface RateSeries {
  network: RateNetwork;
  /** SEP-38 asset string: `stellar:native`, `stellar:CODE:ISSUER` or `iso4217:CODE`. */
  sellAsset: string;
  /** SEP-38 asset string, as for `sellAsset`. */
  buyAsset: string;
  source: RateSampleSource;
  /** The anchor the price came from: required for `sep38_price` and `own_payment`, else null. */
  anchorDomain?: string | null;
}

/** One sample to store. */
export interface RateSampleInput extends RateSeries {
  /** Units of `buyAsset` per one unit of `sellAsset`, as a positive decimal string. */
  rate: string;
  /** When the price was observed: epoch milliseconds, a Date, or an ISO timestamp. */
  sampledAt: number | Date | string;
  /** The payment run this sample came from: required for `own_payment`, else null. */
  runId?: string | null;
  /** Usually left unset; the outlier pass (#602) sets it. */
  outlier?: boolean;
  detail?: Record<string, unknown> | null;
}

/** A stored sample, as `list()` returns it. `sampledAt` is epoch milliseconds. */
export interface RateSampleRecord extends Omit<RateSampleInput, "sampledAt"> {
  id: string;
  anchorDomain: string | null;
  sampledAt: number;
  runId: string | null;
  outlier: boolean;
  detail: Record<string, unknown> | null;
}

export interface ListRateSamplesFilter {
  network?: RateNetwork;
  sellAsset?: string;
  buyAsset?: string;
  source?: RateSampleSource;
  anchorDomain?: string;
  /** Inclusive lower bound on `sampled_at`. */
  since?: number | Date | string;
  /** Inclusive upper bound on `sampled_at`. */
  until?: number | Date | string;
  /** Leave out samples flagged as outliers. Default: include them. */
  excludeOutliers?: boolean;
  /** At most this many rows (1 to 10,000). Unset returns every match. */
  limit?: number;
}

/** The statistics for one series on one UTC day. Rates are decimal strings. */
export interface RateDailySummary extends RateSeries {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Samples the statistics were computed from (outliers excluded). */
  sampleCount: number;
  outlierCount?: number;
  /** All five are null when `sampleCount` is 0, and all five are set otherwise. */
  minRate: string | null;
  p25Rate: string | null;
  medianRate: string | null;
  p75Rate: string | null;
  maxRate: string | null;
}

export interface RateDailySummaryRecord extends RateDailySummary {
  anchorDomain: string | null;
  outlierCount: number;
  /** Epoch milliseconds. */
  computedAt: number;
}

export interface ListRateDailySummariesFilter {
  network?: RateNetwork;
  sellAsset?: string;
  buyAsset?: string;
  source?: RateSampleSource;
  anchorDomain?: string;
  /** Inclusive, `YYYY-MM-DD`. */
  fromDay?: string;
  /** Inclusive, `YYYY-MM-DD`. */
  toDay?: string;
}

interface SampleRow {
  id: string | number;
  network: RateNetwork;
  sell_asset: string;
  buy_asset: string;
  source: RateSampleSource;
  anchor_domain: string | null;
  rate: string;
  sampled_at: Date | string;
  run_id: string | null;
  outlier: boolean;
  detail: Record<string, unknown> | null;
}

interface SummaryRow {
  network: RateNetwork;
  sell_asset: string;
  buy_asset: string;
  source: RateSampleSource;
  anchor_domain: string | null;
  day: string;
  sample_count: number;
  outlier_count: number;
  min_rate: string | null;
  p25_rate: string | null;
  median_rate: string | null;
  p75_rate: string | null;
  max_rate: string | null;
  computed_at: Date | string;
}

const DECIMAL = /^\d+(?:\.\d+)?$/;
/** SEP-38 Asset Identification Format. */
const SEP38_ASSET =
  /^(?:stellar:native|stellar:[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}|iso4217:[A-Z]{3})$/;
/** A lowercase host name, with a port for a local reference anchor. No scheme, no path. */
const DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 10_000;

function toDate(value: number | Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new RangeError(`${field} is not a valid time: ${String(value)}`);
  return date;
}

function assertDay(day: string, field: string): void {
  // Round-trip through Date so 2026-02-30 is refused, not rolled over to March.
  if (
    typeof day !== "string" ||
    !DAY.test(day) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  ) {
    throw new RangeError(
      `${field} must be a calendar day as YYYY-MM-DD, got ${JSON.stringify(day)}`,
    );
  }
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value) && /[1-9]/.test(value);
}

/** Exact comparison of two positive plain decimal strings, without a float in between. */
function compareDecimal(a: string, b: string): number {
  const [aw = "", af = ""] = a.split(".");
  const [bw = "", bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const x = BigInt(aw + af.padEnd(scale, "0"));
  const y = BigInt(bw + bf.padEnd(scale, "0"));
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Rejects a series whose fields would not match the table's constraints. */
function assertSeries(series: RateSeries): void {
  if (!RATE_NETWORKS.includes(series.network)) {
    throw new RangeError(
      `network must be testnet or public, got ${JSON.stringify(series.network)}`,
    );
  }
  if (!RATE_SAMPLE_SOURCES.includes(series.source)) {
    throw new RangeError(`unknown rate sample source: ${String(series.source)}`);
  }
  for (const [field, asset] of [
    ["sellAsset", series.sellAsset],
    ["buyAsset", series.buyAsset],
  ] as const) {
    if (typeof asset !== "string" || !SEP38_ASSET.test(asset)) {
      throw new RangeError(
        `${field} must be a SEP-38 asset (stellar:native, stellar:CODE:ISSUER or iso4217:CODE), got ${JSON.stringify(asset)}`,
      );
    }
  }
  if (series.sellAsset === series.buyAsset) {
    throw new RangeError("sellAsset and buyAsset must differ");
  }
  const domain = series.anchorDomain ?? null;
  if (ANCHOR_RATE_SOURCES.includes(series.source)) {
    if (domain === null || !DOMAIN.test(domain)) {
      throw new RangeError(
        `a ${series.source} sample needs a lowercase anchorDomain, got ${JSON.stringify(domain)}`,
      );
    }
  } else if (domain !== null) {
    throw new RangeError(
      `a ${series.source} sample belongs to no anchor; anchorDomain must be null`,
    );
  }
}

/** Rejects a sample the table would refuse, before it reaches SQL. */
export function assertRateSample(sample: RateSampleInput): void {
  assertSeries(sample);
  if (!isPositiveDecimal(sample.rate)) {
    throw new RangeError(
      `rate must be a positive decimal string, got ${JSON.stringify(sample.rate)}`,
    );
  }
  const runId = sample.runId ?? null;
  if (sample.source === "own_payment") {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new RangeError("an own_payment sample needs the runId of its payment");
    }
  } else if (runId !== null) {
    throw new RangeError(`a ${sample.source} sample has no payment run; runId must be null`);
  }
  if (sample.outlier !== undefined && typeof sample.outlier !== "boolean") {
    throw new RangeError("outlier must be a boolean");
  }
  toDate(sample.sampledAt, "sampledAt");
}

/** Rejects a summary the table would refuse, before it reaches SQL. */
export function assertRateDailySummary(summary: RateDailySummary): void {
  assertSeries(summary);
  assertDay(summary.day, "day");
  for (const [field, count] of [
    ["sampleCount", summary.sampleCount],
    ["outlierCount", summary.outlierCount ?? 0],
  ] as const) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`${field} must be a non-negative integer`);
    }
  }
  const stats = [
    summary.minRate,
    summary.p25Rate,
    summary.medianRate,
    summary.p75Rate,
    summary.maxRate,
  ];
  if (summary.sampleCount === 0) {
    if (stats.some((s) => s !== null && s !== undefined)) {
      throw new RangeError("a summary of zero samples has no rates; leave them null");
    }
    return;
  }
  if (!stats.every(isPositiveDecimal)) {
    throw new RangeError("min, p25, median, p75 and max must be positive decimal strings");
  }
  for (let i = 1; i < stats.length; i++) {
    if (compareDecimal(stats[i - 1] as string, stats[i] as string) > 0) {
      throw new RangeError("rates must be ordered min <= p25 <= median <= p75 <= max");
    }
  }
}

function epochMs(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

/** Builds a `where` clause from equality and range conditions, numbering params as it goes. */
function whereBuilder() {
  const clauses: string[] = [];
  const params: unknown[] = [];
  return {
    add(column: string, op: string, value: unknown) {
      params.push(value);
      clauses.push(`${column} ${op} $${params.length}`);
    },
    raw(clause: string) {
      clauses.push(clause);
    },
    sql: () => (clauses.length ? `where ${clauses.join(" and ")}` : ""),
    params,
  };
}

export class PostgresRateHistoryStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Insert one sample. Returns false, and stores nothing, when the series already has a sample
   * at that instant (or the payment run already has one), so a collector can safely re-read an
   * overlapping window. Throws RangeError on a sample the table would refuse.
   */
  async record(sample: RateSampleInput): Promise<boolean> {
    assertRateSample(sample);
    const res = await this.db.query<{ id: string }>(
      `insert into rate_samples (
        network, sell_asset, buy_asset, source, anchor_domain, rate, sampled_at, run_id, outlier,
        detail
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict do nothing
      returning id`,
      [
        sample.network,
        sample.sellAsset,
        sample.buyAsset,
        sample.source,
        sample.anchorDomain ?? null,
        sample.rate,
        toDate(sample.sampledAt, "sampledAt").toISOString(),
        sample.runId ?? null,
        sample.outlier ?? false,
        sample.detail ? JSON.stringify(sample.detail) : null,
      ],
    );
    return res.rows.length > 0;
  }

  /** Samples matching `filter`, newest first. */
  async list(filter: ListRateSamplesFilter = {}): Promise<RateSampleRecord[]> {
    const w = whereBuilder();
    if (filter.network) w.add("network", "=", filter.network);
    if (filter.sellAsset) w.add("sell_asset", "=", filter.sellAsset);
    if (filter.buyAsset) w.add("buy_asset", "=", filter.buyAsset);
    if (filter.source) w.add("source", "=", filter.source);
    if (filter.anchorDomain) w.add("anchor_domain", "=", filter.anchorDomain);
    if (filter.since !== undefined)
      w.add("sampled_at", ">=", toDate(filter.since, "since").toISOString());
    if (filter.until !== undefined)
      w.add("sampled_at", "<=", toDate(filter.until, "until").toISOString());
    if (filter.excludeOutliers) w.raw("not outlier");

    let limit = "";
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1) {
        throw new RangeError("limit must be a positive integer");
      }
      limit = `limit ${Math.min(filter.limit, MAX_LIMIT)}`;
    }

    const res = await this.db.query<SampleRow>(
      `select id, network, sell_asset, buy_asset, source, anchor_domain, rate::text as rate,
              sampled_at, run_id, outlier, detail
       from rate_samples
       ${w.sql()}
       order by sampled_at desc, id desc
       ${limit}`,
      w.params,
    );

    return res.rows.map((r) => ({
      id: String(r.id),
      network: r.network,
      sellAsset: r.sell_asset,
      buyAsset: r.buy_asset,
      source: r.source,
      anchorDomain: r.anchor_domain,
      rate: r.rate,
      sampledAt: epochMs(r.sampled_at),
      runId: r.run_id,
      outlier: r.outlier,
      detail: r.detail,
    }));
  }

  /**
   * Write (or rewrite) one series' summary for one day. Recomputing a day replaces its row, so
   * the daily job can run again after a late sample or a new outlier flag.
   */
  async upsertDailySummary(summary: RateDailySummary): Promise<void> {
    assertRateDailySummary(summary);
    await this.db.query(
      `insert into rate_daily_summaries (
        network, sell_asset, buy_asset, source, anchor_domain, day, sample_count, outlier_count,
        min_rate, p25_rate, median_rate, p75_rate, max_rate
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      on conflict (network, sell_asset, buy_asset, source, anchor_domain, day) do update set
        sample_count = excluded.sample_count,
        outlier_count = excluded.outlier_count,
        min_rate = excluded.min_rate,
        p25_rate = excluded.p25_rate,
        median_rate = excluded.median_rate,
        p75_rate = excluded.p75_rate,
        max_rate = excluded.max_rate,
        computed_at = now()`,
      [
        summary.network,
        summary.sellAsset,
        summary.buyAsset,
        summary.source,
        summary.anchorDomain ?? null,
        summary.day,
        summary.sampleCount,
        summary.outlierCount ?? 0,
        summary.minRate ?? null,
        summary.p25Rate ?? null,
        summary.medianRate ?? null,
        summary.p75Rate ?? null,
        summary.maxRate ?? null,
      ],
    );
  }

  /** Daily summaries matching `filter`, oldest day first. */
  async listDailySummaries(
    filter: ListRateDailySummariesFilter = {},
  ): Promise<RateDailySummaryRecord[]> {
    const w = whereBuilder();
    if (filter.network) w.add("network", "=", filter.network);
    if (filter.sellAsset) w.add("sell_asset", "=", filter.sellAsset);
    if (filter.buyAsset) w.add("buy_asset", "=", filter.buyAsset);
    if (filter.source) w.add("source", "=", filter.source);
    if (filter.anchorDomain) w.add("anchor_domain", "=", filter.anchorDomain);
    if (filter.fromDay !== undefined) {
      assertDay(filter.fromDay, "fromDay");
      w.add("day", ">=", filter.fromDay);
    }
    if (filter.toDay !== undefined) {
      assertDay(filter.toDay, "toDay");
      w.add("day", "<=", filter.toDay);
    }

    const res = await this.db.query<SummaryRow>(
      `select network, sell_asset, buy_asset, source, anchor_domain, to_char(day, 'YYYY-MM-DD') as day,
              sample_count, outlier_count, min_rate::text as min_rate, p25_rate::text as p25_rate,
              median_rate::text as median_rate, p75_rate::text as p75_rate,
              max_rate::text as max_rate, computed_at
       from rate_daily_summaries
       ${w.sql()}
       order by day, network, sell_asset, buy_asset, source, anchor_domain nulls first`,
      w.params,
    );

    return res.rows.map((r) => ({
      network: r.network,
      sellAsset: r.sell_asset,
      buyAsset: r.buy_asset,
      source: r.source,
      anchorDomain: r.anchor_domain,
      day: r.day,
      sampleCount: Number(r.sample_count),
      outlierCount: Number(r.outlier_count),
      minRate: r.min_rate,
      p25Rate: r.p25_rate,
      medianRate: r.median_rate,
      p75Rate: r.p75_rate,
      maxRate: r.max_rate,
      computedAt: epochMs(r.computed_at),
    }));
  }
}
