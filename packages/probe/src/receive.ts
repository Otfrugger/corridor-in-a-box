// The SEP-31 receive list, with the amount bounds an anchor states for each asset.
//
// This is the OBSERVED kind of fact: a probe called `/info` and this is what came
// back. The registry stores it under its own key (`get_receive`) so a planner can
// rule a lane in or out by amount without asking the anchor.
//
// An amount on chain is an integer scaled by 10^7, the precision Stellar itself
// carries. So a bound is only recorded when it can be written on that scale
// exactly. Anything else is left out, and nothing here rounds: a minimum rounded
// down, or a maximum rounded up, would be a number the anchor never gave.

import { STROOP_SCALE, fromScaled, toScaled } from "@corridor/types";

/** One asset from a SEP-31 `/info` receive list, with the bounds stated for it. */
export interface ReceiveAssetLimits {
  /** The asset code exactly as `/info` keyed it. */
  readonly code: string;
  /**
   * `min_amount`, as a decimal string of at most seven places. Absent when the
   * anchor stated none, or stated something that is not an amount this registry
   * can hold. Absent is not zero: it is "no minimum was recorded".
   */
  readonly minAmount?: string;
  /** `max_amount`, on the same terms. Absent is not "no upper bound". */
  readonly maxAmount?: string;
}

/** The largest amount the contract can hold: an i128, on the 10^7 scale. */
const MAX_SCALED = (1n << 127n) - 1n;

/** A plain non-negative decimal: digits, optionally a point and more digits. */
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Digits a JSON number can carry and still be the decimal the anchor wrote. A
 * double holds any decimal of up to 15 significant digits exactly enough to print
 * it back; past that, the digits printed are the double's, not the anchor's. (A
 * longer literal that parses to the very same double as a short one is read as
 * the short one. Once JSON has been parsed there is no telling them apart.)
 */
const EXACT_DIGITS = 15;

/**
 * A JSON number as the plain decimal it was written as, or undefined when it
 * cannot be recovered: not finite, negative, or more digits than a double keeps.
 */
function plainDecimal(n: number): string | undefined {
  if (!Number.isFinite(n) || n < 0) return undefined;
  // The shortest text that reads back as the same number. It may use an exponent
  // (1e-7, 1e+21), which is undone below.
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
  if (!m) return undefined;
  const int = m[1] ?? "";
  const digits = int + (m[2] ?? "");
  if (digits.replace(/^0+/, "").length > EXACT_DIGITS) return undefined;

  const point = int.length + Number(m[3] ?? 0);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * One bound from a `/info` response as a canonical decimal string, or undefined
 * when it is not an amount that can be recorded.
 *
 * Accepts a JSON number, which is what SEP-31 specifies, or a plain decimal
 * string, which some anchors send instead. Refuses, by returning undefined:
 * anything negative, anything with an exponent or a sign in a string, more than
 * seven decimal places, and a value too large for the contract. Refusing is the
 * point. The caller then records that no bound was observed, which is true,
 * rather than a rounded or repaired number, which would not be.
 */
export function receiveBound(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === "number") text = plainDecimal(value);
  else if (typeof value === "string" && PLAIN_DECIMAL.test(value.trim())) text = value.trim();
  if (text === undefined) return undefined;

  const scaled = toScaled(text, STROOP_SCALE);
  if (!scaled.ok || scaled.value < 0n || scaled.value > MAX_SCALED) return undefined;
  return fromScaled(scaled.value, STROOP_SCALE);
}

/**
 * The receive list of a SEP-31 `/info` response: one entry per asset, in the
 * order the response listed them, each with whatever bounds it stated.
 */
export function receiveLimitsFrom(receive: Record<string, unknown>): ReceiveAssetLimits[] {
  return Object.entries(receive).map(([code, entry]) => {
    const stated =
      entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const minAmount = receiveBound(stated.min_amount);
    const maxAmount = receiveBound(stated.max_amount);
    return {
      code,
      ...(minAmount === undefined ? {} : { minAmount }),
      ...(maxAmount === undefined ? {} : { maxAmount }),
    };
  });
}

/**
 * A receive list as one line for a job log: `NGN 1000 to 5000000, USDC from 0.1,
 * KES (no bounds stated)`. An asset with no recorded bound says so, so that a
 * reader does not take the silence for "any amount".
 */
export function describeReceiveLimits(limits: readonly ReceiveAssetLimits[]): string {
  if (limits.length === 0) return "no receivable assets";
  return limits
    .map(({ code, minAmount, maxAmount }) => {
      if (minAmount !== undefined && maxAmount !== undefined) {
        return `${code} ${minAmount} to ${maxAmount}`;
      }
      if (minAmount !== undefined) return `${code} from ${minAmount}`;
      if (maxAmount !== undefined) return `${code} up to ${maxAmount}`;
      return `${code} (no bounds stated)`;
    })
    .join(", ");
}

/**
 * Check a receive list read back from a file, the way `parseProbeResults` checks
 * the rest of a stored result. Returns the list with its amounts in canonical
 * form, or throws naming what is wrong.
 *
 * A stored bound has to be one `receiveBound` would have produced. A file with
 * `"minAmount": "-5"` or eight decimal places was edited by hand, and the place
 * to find that out is here, not in a contract revert an hour into a sweep.
 */
export function parseReceiveLimits(raw: unknown, domain: string): ReceiveAssetLimits[] {
  const bad = (why: string): never => {
    throw new Error(`Probe result for ${domain} has an invalid receiveLimits list (${why})`);
  };
  if (!Array.isArray(raw)) return bad("expected an array");

  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return bad(`entry ${i} is not an object`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.code !== "string" || entry.code.length === 0) {
      return bad(`entry ${i} has no asset code`);
    }
    const bound = (key: "minAmount" | "maxAmount"): string | undefined => {
      const value = entry[key];
      if (value === undefined) return undefined;
      const parsed = typeof value === "string" ? receiveBound(value) : undefined;
      if (parsed === undefined) {
        return bad(
          `${entry.code} ${key} must be a non-negative decimal string of at most ` +
            `${STROOP_SCALE} places`,
        );
      }
      return parsed;
    };
    const minAmount = bound("minAmount");
    const maxAmount = bound("maxAmount");
    return {
      code: entry.code,
      ...(minAmount === undefined ? {} : { minAmount }),
      ...(maxAmount === undefined ? {} : { maxAmount }),
    };
  });
}
