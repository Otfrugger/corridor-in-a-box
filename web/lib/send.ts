// The testnet send app's own logic (RFC 0004 §6): validating the amount,
// wording each route's price and reasons, timing a locked price, and turning an
// anchor's published requirements into recipient form fields.
//
// Pure and self-contained on purpose, like send-errors.ts: the only imports are
// types, so client components can use it without pulling server code into the
// browser, and the repo's root suite unit-tests it.
//
// Nothing here invents a route, a rate or a field. Routes come from the router
// (`RouteOption`, packages/router/src/planner.ts) and fields from the receiving
// anchor's own GET /sep31/info and SEP-12 GET /customer responses. Where those
// come from is up to the caller: see the `PlanRoutes` and `LoadReceiverFields`
// seams below.

import type { PriceLabel, RouteOption, RouteRequest } from "@corridor/router";
import type { Money } from "@corridor/types";
import type { DroppedRoute } from "./send-errors";

export type { PriceLabel, RouteOption, RouteRequest };

// --- Amount and destination (#685) ------------------------------------------

/** Stellar holds amounts to 7 decimal places. */
export const AMOUNT_DECIMALS = 7;

/** The largest amount a Stellar operation can carry: int64 max, in stroops. */
export const MAX_STELLAR_AMOUNT = "922337203685.4775807";

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

/** A decimal string as an integer count of 10^-7 units, or null if it is not one. */
function toStroops(amount: string): bigint | null {
  if (!AMOUNT_PATTERN.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > AMOUNT_DECIMALS) return null;
  return BigInt(whole + frac.padEnd(AMOUNT_DECIMALS, "0"));
}

export type AmountCheck =
  | { valid: true; /** The trimmed amount, as it should be sent. */ amount: string }
  | { valid: false; error: string };

/**
 * Checks the amount a sender typed. Works on the string throughout, so no
 * amount is ever rounded through a float. `limits` are the receiving anchor's
 * own min and max, as decimal strings, when the caller has them.
 */
export function validateSendAmount(
  input: string,
  limits: { min?: string; max?: string } = {},
): AmountCheck {
  const amount = input.trim();
  if (amount === "") return { valid: false, error: "Enter an amount to send." };
  if (amount.startsWith("-")) {
    return { valid: false, error: "The amount must be more than zero." };
  }
  if (!AMOUNT_PATTERN.test(amount)) {
    return {
      valid: false,
      error: "Use digits only, with a dot for decimals, for example 25.50.",
    };
  }
  const decimals = amount.split(".")[1]?.length ?? 0;
  if (decimals > AMOUNT_DECIMALS) {
    return {
      valid: false,
      error: `Use at most ${AMOUNT_DECIMALS} digits after the decimal point.`,
    };
  }
  const stroops = toStroops(amount);
  if (stroops === null || stroops <= 0n) {
    return { valid: false, error: "The amount must be more than zero." };
  }
  if (stroops > (toStroops(MAX_STELLAR_AMOUNT) as bigint)) {
    return { valid: false, error: "That amount is too large to send on Stellar." };
  }
  const min = limits.min !== undefined ? toStroops(limits.min) : null;
  if (min !== null && stroops < min) {
    return { valid: false, error: `The smallest amount you can send is ${limits.min}.` };
  }
  const max = limits.max !== undefined ? toStroops(limits.max) : null;
  if (max !== null && stroops > max) {
    return { valid: false, error: `The largest amount you can send is ${limits.max}.` };
  }
  return { valid: true, amount };
}

/** A country and currency a payment can be sent to. */
export interface Destination {
  /** ISO 3166-1 alpha-2, for example NG. */
  country: string;
  /** ISO 4217, for example NGN. */
  currency: string;
}

/** The structural part of a corridor manifest the destination list reads. */
export interface CorridorLike {
  source: { asset: string };
  dest: { asset: string };
  compliance: { dest_jurisdiction: string };
  settlement: { network: string };
}

/**
 * The destinations and source assets the send app offers, read from the
 * corridor manifests rather than typed out by hand. Only testnet lanes count:
 * this app never moves real money.
 */
export function sendOptionsFromCorridors(corridors: readonly CorridorLike[]): {
  destinations: Destination[];
  sourceAssets: string[];
} {
  const destinations = new Map<string, Destination>();
  const sourceAssets = new Set<string>();
  for (const c of corridors) {
    if (c.settlement.network !== "testnet") continue;
    const currency = currencyCode(c.dest.asset);
    const country = c.compliance.dest_jurisdiction.toUpperCase();
    destinations.set(`${country}:${currency}`, { country, currency });
    sourceAssets.add(c.source.asset);
  }
  return {
    destinations: [...destinations.values()].sort(
      (a, b) => a.country.localeCompare(b.country) || a.currency.localeCompare(b.currency),
    ),
    sourceAssets: [...sourceAssets].sort(),
  };
}

/** What the sender asked for, as the router's `RouteRequest`. */
export function toRouteRequest(input: {
  amount: string;
  sourceAsset: string;
  destination: Destination;
}): RouteRequest {
  return {
    sourceAmount: { asset: input.sourceAsset, amount: input.amount },
    destAsset: `iso4217:${input.destination.currency}`,
    destCountry: input.destination.country,
  };
}

// --- Route options and their labels (#686) ----------------------------------

/**
 * What a route planner gives back: the ranked options, best first, and the
 * routes it ruled out with the reason for each.
 */
export interface PlannedRoutes {
  options: readonly RouteOption[];
  dropped?: readonly DroppedRoute[];
}

/**
 * The send app's seam to a route planner. @corridor/service does not offer
 * route planning yet (POST /routes is still being built), so whoever renders
 * the app injects this. A browser implementation must call the web app's own
 * /api/send/... routes, never the service directly: the service API key stays
 * on the server (lib/send-proxy.ts).
 */
export type PlanRoutes = (request: RouteRequest) => Promise<PlannedRoutes>;

/** All three labels, in the order RFC 0004 §2 lists them. None is ever folded into another. */
export const PRICE_LABELS: readonly PriceLabel[] = ["locked", "indicative", "estimated"];

/** What each label means, in plain words. */
export const PRICE_LABEL_MEANING: Readonly<Record<PriceLabel, string>> = {
  locked: "A firm quote from the receiving anchor. This amount is held until the timer runs out.",
  indicative: "The anchor's current price. It is not promised and can change before payout.",
  estimated: "Worked out from recent rates. The anchor has not quoted this payment.",
};

/** A payout or source asset as a sender reads it: iso4217:NGN is NGN, USDC:G... is USDC. */
export function currencyCode(asset: string): string {
  const withoutScheme = asset.startsWith("iso4217:") ? asset.slice("iso4217:".length) : asset;
  return withoutScheme.split(":")[0] ?? withoutScheme;
}

/** Groups the whole part of a decimal string in threes, without going through a float. */
export function formatAmount(amount: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return amount;
  const [, sign = "", whole = "0", frac] = match;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${frac}`;
}

export function formatMoney(money: Money): string {
  return `${formatAmount(money.amount)} ${currencyCode(money.asset)}`;
}

/**
 * The line that leads each option, in RFC 0004 §2's words for its label.
 * A locked price shows the seconds it has left, so pass the current time.
 */
export function describePrice(
  option: RouteOption,
  nowMs: number,
  opts: { guaranteeEstimates?: boolean } = {},
): string {
  const amount = formatMoney(option.recipientGets);
  switch (option.price.label) {
    case "locked": {
      const left = quoteSecondsLeft(option, nowMs) ?? 0;
      return left > 0
        ? `Recipient gets ${amount}. Locked for ${left} s.`
        : `Recipient gets ${amount}. This locked price has expired.`;
    }
    case "indicative":
      return `About ${amount}. Final amount set at payout.`;
    case "estimated":
      return opts.guaranteeEstimates
        ? `At least ${amount} (estimated)`
        : `About ${amount} (estimated)`;
  }
}

/** A stable key for one option, for React lists and for remembering the sender's pick. */
export function routeKey(option: RouteOption): string {
  return [
    option.corridorId,
    option.receivingDomain,
    option.protocol,
    option.price.label,
    option.price.quoteId ?? "",
  ].join("|");
}

/** Router reason strings (packages/router/src/reasons.ts) and how each reads in plain words. */
const REASON_WORDING: ReadonlyArray<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^locked for ([\d.]+) s$/, (m) => `The anchor holds this price for ${m[1]} seconds.`],
  [/^indicative rate from (.+)$/, (m) => `Today's price from ${m[1]}.`],
  [/^indicative rate$/, () => "Today's price from the receiving anchor."],
  [
    /^estimated from ([\d,]+) samples over (\d+) d$/,
    (m) => `Worked out from ${m[1]} rates seen over the last ${m[2]} days.`,
  ],
  [/^dropped: amount above max (.+)$/, (m) => `The amount is above this anchor's limit of ${m[1]}.`],
  [/^dropped: amount below min (.+)$/, (m) => `The amount is below this anchor's minimum of ${m[1]}.`],
  [
    /^dropped: missing required fields: (.+)$/,
    (m) => `This anchor needs details we can't supply yet: ${m[1]}.`,
  ],
  [/^dropped: circuit breaker open.*$/, () => "This anchor failed several recent payments, so it is paused."],
  [/^dropped: lane not open \((.+)\)$/, () => "This anchor is not taking payments from this sender right now."],
  [/^dropped: no price within ([\d.]+) s$/, (m) => `This anchor did not answer with a price within ${m[1]} seconds.`],
  [/^dropped: label (\w+) excluded by policy.*$/, (m) => `Prices labelled ${m[1]} are turned off for this app.`],
  [/^dropped: insufficient history.*$/, () => "There is not enough rate history yet to estimate a price."],
];

/**
 * One router reason in plain words. Formats the router does not document are
 * shown as they are, with a capital letter and a full stop, rather than hidden.
 */
export function plainReason(reason: string): string {
  const trimmed = reason.trim();
  for (const [pattern, word] of REASON_WORDING) {
    const m = pattern.exec(trimmed);
    if (m) return word(m);
  }
  const text = trimmed.replace(/^dropped:\s*/, "");
  if (text === "") return text;
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

// --- Locked price countdown (#687) ------------------------------------------

/** Under this many seconds left, the countdown warns the sender. */
export const QUOTE_WARNING_SECONDS = 15;

/** Whole seconds left on a locked price, or undefined for a price that is not locked. */
export function quoteSecondsLeft(option: RouteOption, nowMs: number): number | undefined {
  if (option.price.label !== "locked") return undefined;
  const expiresAt = option.price.expiresAt;
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return 0;
  return Math.max(0, Math.floor((expiresAt - nowMs) / 1000));
}

/**
 * True once a locked price can no longer be used. A locked option without an
 * expiry counts as expired: nothing says the anchor still holds it.
 */
export function isQuoteExpired(option: RouteOption, nowMs: number): boolean {
  if (option.price.label !== "locked") return false;
  const expiresAt = option.price.expiresAt;
  return expiresAt === undefined || !Number.isFinite(expiresAt) || nowMs >= expiresAt;
}

/** Seconds as m:ss, for the countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// --- Recipient details from the anchor's requirements (#688) ----------------

/**
 * One field the receiving anchor asks for. `source` says where the anchor
 * published it, which is also where the value has to go: SEP-31 transaction
 * fields travel with the payment (`destinationFields`), SEP-12 fields go to
 * the anchor's KYC server.
 */
export interface ReceiverField {
  name: string;
  /** A readable name made from `name`. */
  label: string;
  /** The anchor's own description of the field. */
  description?: string;
  optional: boolean;
  /** Allowed values, when the anchor restricts them. */
  choices?: string[];
  /** SEP-12 field type; SEP-31 transaction fields are strings. */
  type: "string" | "number" | "date" | "binary";
  source: "sep31-transaction" | "sep12";
}

/**
 * The send app's seam for the chosen route's fields. An implementation reads
 * the receiving anchor's GET /sep31/info (and SEP-12 GET /customer for the
 * receiver type it names) through a server route and turns the responses into
 * fields with the parsers below. Called again whenever the route changes.
 */
export type LoadReceiverFields = (option: RouteOption) => Promise<ReceiverField[]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** first_name to "First name", receiver_routing_number to "Receiver routing number". */
export function fieldLabel(name: string): string {
  const words = name.replace(/[_\-.]+/g, " ").trim();
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

function stringChoices(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const choices = v.filter((c): c is string => typeof c === "string" && c !== "");
  return choices.length > 0 ? choices : undefined;
}

function fieldFromSpec(
  name: string,
  spec: unknown,
  source: ReceiverField["source"],
  type: ReceiverField["type"],
): ReceiverField {
  const s = isRecord(spec) ? spec : {};
  const choices = stringChoices(s.choices);
  return {
    name,
    label: fieldLabel(name),
    ...(typeof s.description === "string" && s.description.trim() !== ""
      ? { description: s.description.trim() }
      : {}),
    optional: s.optional === true,
    ...(choices ? { choices } : {}),
    type,
    source,
  };
}

/**
 * The transaction fields a SEP-31 receiving anchor lists for `asset` in its
 * GET /sep31/info response, under `receive.<asset>.fields.transaction`.
 * Anything malformed is skipped rather than guessed at.
 */
export function receiverFieldsFromSep31Info(info: unknown, asset: string): ReceiverField[] {
  if (!isRecord(info) || !isRecord(info.receive)) return [];
  const entry = info.receive[asset];
  if (!isRecord(entry) || !isRecord(entry.fields) || !isRecord(entry.fields.transaction)) {
    return [];
  }
  return Object.entries(entry.fields.transaction).map(([name, spec]) =>
    fieldFromSpec(name, spec, "sep31-transaction", "string"),
  );
}

/** The SEP-12 receiver type the anchor names for `asset`, for example sep31-receiver. */
export function sep12ReceiverTypes(info: unknown, asset: string): string[] {
  if (!isRecord(info) || !isRecord(info.receive)) return [];
  const entry = info.receive[asset];
  if (!isRecord(entry) || !isRecord(entry.sep12) || !isRecord(entry.sep12.receiver)) return [];
  const types = entry.sep12.receiver.types;
  return isRecord(types) ? Object.keys(types) : [];
}

const SEP12_TYPES = new Set(["string", "number", "date", "binary"]);

/**
 * The fields a SEP-12 GET /customer response still asks for (its `fields`
 * object). Fields the customer already provided are not in it, per SEP-12.
 */
export function receiverFieldsFromSep12(customer: unknown): ReceiverField[] {
  if (!isRecord(customer) || !isRecord(customer.fields)) return [];
  return Object.entries(customer.fields).map(([name, spec]) => {
    const raw = isRecord(spec) && typeof spec.type === "string" ? spec.type : "string";
    const type = (SEP12_TYPES.has(raw) ? raw : "string") as ReceiverField["type"];
    return fieldFromSpec(name, spec, "sep12", type);
  });
}

/** Joins field lists, keeping the first field of each name. */
export function mergeReceiverFields(...lists: ReadonlyArray<readonly ReceiverField[]>): ReceiverField[] {
  const seen = new Map<string, ReceiverField>();
  for (const list of lists) {
    for (const field of list) if (!seen.has(field.name)) seen.set(field.name, field);
  }
  return [...seen.values()];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Checks the sender's entries against the anchor's fields. Errors are keyed by
 * field name, worded for the person filling the form in.
 */
export function validateReceiverFields(
  fields: readonly ReceiverField[],
  values: Readonly<Record<string, string>>,
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.name] ?? "").trim();
    if (field.type === "binary") {
      if (!field.optional) {
        errors[field.name] = `${field.label} is a document upload, which this app can't send yet.`;
      }
      continue;
    }
    if (value === "") {
      if (!field.optional) errors[field.name] = `Enter the ${field.label.toLowerCase()}.`;
      continue;
    }
    if (field.choices && !field.choices.includes(value)) {
      errors[field.name] = `Pick one of the listed options for ${field.label.toLowerCase()}.`;
    } else if (field.type === "number" && !NUMBER_PATTERN.test(value)) {
      errors[field.name] = `${field.label} must be a number.`;
    } else if (field.type === "date" && !DATE_PATTERN.test(value)) {
      errors[field.name] = `${field.label} must be a date.`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * The entries split by where they go: SEP-31 transaction fields become the
 * payment's `destinationFields`; SEP-12 fields go to the anchor's KYC server.
 * Empty optional entries are left out.
 */
export function splitReceiverValues(
  fields: readonly ReceiverField[],
  values: Readonly<Record<string, string>>,
): { destinationFields: Record<string, string>; customerFields: Record<string, string> } {
  const destinationFields: Record<string, string> = {};
  const customerFields: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.name] ?? "").trim();
    if (value === "" || field.type === "binary") continue;
    if (field.source === "sep31-transaction") destinationFields[field.name] = value;
    else customerFields[field.name] = value;
  }
  return { destinationFields, customerFields };
}

// --- Sending ----------------------------------------------------------------

/** Everything the sender chose, ready for whoever sends it. */
export interface SendSelection {
  request: RouteRequest;
  option: RouteOption;
  destinationFields: Record<string, string>;
  customerFields: Record<string, string>;
}

/**
 * The seam for the send step itself. As with the planner, a browser
 * implementation goes through /api/send/payments, never to the service.
 */
export type SendPayment = (selection: SendSelection) => Promise<void>;

export type SendBlock = "no_route" | "quote_expired" | "fields_invalid" | null;

/**
 * Why Send cannot go ahead right now, or null when it can. Checked when the
 * button renders and again at the moment it is pressed, so a price that runs
 * out between the two is still refused.
 */
export function sendBlockedBy(input: {
  option: RouteOption | null;
  nowMs: number;
  fields: readonly ReceiverField[];
  values: Readonly<Record<string, string>>;
}): SendBlock {
  if (!input.option) return "no_route";
  if (isQuoteExpired(input.option, input.nowMs)) return "quote_expired";
  if (!validateReceiverFields(input.fields, input.values).valid) return "fields_invalid";
  return null;
}
