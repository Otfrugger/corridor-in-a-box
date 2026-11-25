export type OptionReasonStep =
  | { kind: "locked"; ttlSeconds: number }
  | { kind: "indicative"; source?: string }
  | { kind: "estimated"; sampleCount: number; windowDays: number }
  | { kind: "amount-above-max"; max: string | number; asset?: string }
  | { kind: "amount-below-min"; min: string | number; asset?: string }
  | { kind: "missing-fields"; fields: readonly string[] }
  | { kind: "breaker-open"; retryAfterSeconds?: number }
  | { kind: "lane-filtered"; state: string }
  | { kind: "pricing-timeout"; timeoutSeconds: number }
  | {
      kind: "label-disallowed";
      label: string;
      allowedLabels: readonly string[];
    }
  | { kind: "insufficient-history"; sampleCount: number; minSamples: number }
  | { kind: "custom"; dropped?: boolean; detail: string };

export interface ReasonedOption {
  reason?: string;
  reasons?: readonly string[];
}

function formatGroupedNumber(value: string | number): string {
  const raw = typeof value === "number" ? String(value) : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) {
    return raw;
  }
  const sign = match[1] ?? "";
  const whole = match[2] ?? "0";
  const frac = match[3];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${frac}`;
}

function formatSeconds(seconds: number): string {
  const clamped = Math.max(0, seconds);
  return Number.isInteger(clamped) ? String(clamped) : Number(clamped.toFixed(2)).toString();
}

/**
 * Formats a planner step event into a short plain-language reason string.
 */
export function formatOptionReason(step: OptionReasonStep): string {
  switch (step.kind) {
    case "locked":
      return `locked for ${formatSeconds(step.ttlSeconds)} s`;
    case "indicative":
      return step.source ? `indicative rate from ${step.source}` : "indicative rate";
    case "estimated":
      return `estimated from ${formatGroupedNumber(step.sampleCount)} samples over ${step.windowDays} d`;
    case "amount-above-max": {
      const limit = formatGroupedNumber(step.max);
      return step.asset
        ? `dropped: amount above max ${limit} ${step.asset}`
        : `dropped: amount above max ${limit}`;
    }
    case "amount-below-min": {
      const limit = formatGroupedNumber(step.min);
      return step.asset
        ? `dropped: amount below min ${limit} ${step.asset}`
        : `dropped: amount below min ${limit}`;
    }
    case "missing-fields":
      return `dropped: missing required fields: ${step.fields.join(", ")}`;
    case "breaker-open":
      return step.retryAfterSeconds !== undefined
        ? `dropped: circuit breaker open (retry in ${formatSeconds(step.retryAfterSeconds)} s)`
        : "dropped: circuit breaker open";
    case "lane-filtered":
      return `dropped: lane not open (${step.state})`;
    case "pricing-timeout":
      return `dropped: no price within ${formatSeconds(step.timeoutSeconds)} s`;
    case "label-disallowed":
      return `dropped: label ${step.label} excluded by policy (allowed: ${step.allowedLabels.join(", ")})`;
    case "insufficient-history":
      return `dropped: insufficient history (${formatGroupedNumber(step.sampleCount)} of ${formatGroupedNumber(step.minSamples)} samples required)`;
    case "custom":
      return step.dropped ? `dropped: ${step.detail}` : step.detail;
  }
}

/**
 * Returns a shallow copy of an option with the formatted planner reason
 * appended to its reason trail and set as its latest `reason`.
 */
export function appendOptionReason<TOption extends object>(
  option: TOption,
  step: OptionReasonStep,
): Omit<TOption, "reason" | "reasons"> & { reason: string; reasons: string[] } {
  const formatted = formatOptionReason(step);
  const rawReasons = (option as ReasonedOption).reasons;
  const existing = Array.isArray(rawReasons) ? [...rawReasons] : [];
  existing.push(formatted);
  return {
    ...option,
    reason: formatted,
    reasons: existing,
  };
}

export interface SummarizedOptionReason {
  receivingDomain: string;
  status: "offered" | "dropped";
  reasons: string[];
}

/**
 * Projects offered and dropped route options into an ordered list of
 * domain, status, and accumulated plain-language reasons.
 */
export function summarizeOptionReasons(
  options: ReadonlyArray<
    ReasonedOption & {
      receivingDomain: string;
      status: "offered" | "dropped";
    }
  >,
): SummarizedOptionReason[] {
  return options.map((option) => ({
    receivingDomain: option.receivingDomain,
    status: option.status,
    reasons: option.reasons ? [...option.reasons] : option.reason ? [option.reason] : [],
  }));
}
