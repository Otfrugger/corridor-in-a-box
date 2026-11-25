"use client";

import { useId } from "react";
import { clsx } from "clsx";
import { Badge } from "@/components/ui/Badge";
import {
  PRICE_LABEL_MEANING,
  currencyCode,
  describePrice,
  formatAmount,
  formatMoney,
  isQuoteExpired,
  plainReason,
  routeKey,
  type PriceLabel,
  type RouteOption,
} from "@/lib/send";

interface RouteOptionsListProps {
  /** Ranked best first, as the planner returned them. The list keeps that order. */
  options: readonly RouteOption[];
  selectedKey?: string;
  onSelect: (option: RouteOption) => void;
  /** The shared clock, so every locked price counts down in step with the Send button. */
  nowMs: number;
  /** What the sender pays in, for the rate line. */
  sourceAsset: string;
  guaranteeEstimates?: boolean;
}

const BADGE: Record<PriceLabel, "success" | "info" | "warning"> = {
  locked: "success",
  indicative: "info",
  estimated: "warning",
};

/**
 * Step 2 (#686): the ranked routes. Each option shows its own price label and
 * RFC 0004 §2 wording, and its reasons in plain words. Labels are never merged
 * or hidden: every option carries its own, whatever the others say.
 *
 * A native radio group, so arrow keys move between options and Tab leaves the
 * list, with no custom key handling.
 */
export function RouteOptionsList({
  options,
  selectedKey,
  onSelect,
  nowMs,
  sourceAsset,
  guaranteeEstimates,
}: RouteOptionsListProps) {
  const uid = useId();
  const name = `${uid}-route`;

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-1">
        <span className="block text-lg font-semibold tracking-tight">Pick a route</span>
        <span className="mt-1 block max-w-prose text-sm text-secondary-text">
          Best first. Each price says whether it is locked, indicative or estimated.
        </span>
      </legend>

      <ol className="flex flex-col gap-3">
        {options.map((option, index) => {
          const key = routeKey(option);
          const selected = key === selectedKey;
          const expired = isQuoteExpired(option, nowMs);
          const nameId = `${uid}-name-${index}`;
          const labelId = `${uid}-label-${index}`;
          const headlineId = `${uid}-headline-${index}`;
          const meaningId = `${uid}-meaning-${index}`;
          const dest = currencyCode(option.recipientGets.asset);
          return (
            <li key={key}>
              <label
                className={clsx(
                  "flex cursor-pointer gap-3 rounded-xl border bg-background p-4 transition-colors focus-within:border-accent",
                  selected
                    ? "border-accent ring-1 ring-accent"
                    : "border-border hover:border-secondary-text/60",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={key}
                  checked={selected}
                  onChange={() => onSelect(option)}
                  aria-labelledby={`${nameId} ${labelId} ${headlineId}`}
                  aria-describedby={meaningId}
                  className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs font-semibold tabular-nums text-secondary-text">
                      #{index + 1}
                    </span>
                    <span id={nameId} className="min-w-0 font-medium break-words">
                      {option.receivingDomain}
                    </span>
                    <span id={labelId}>
                      <Badge variant={BADGE[option.price.label]}>{option.price.label}</Badge>
                    </span>
                  </div>

                  <p
                    id={headlineId}
                    className={clsx(
                      "text-base font-semibold tabular-nums",
                      expired && "text-secondary-text line-through decoration-1",
                    )}
                  >
                    {describePrice(option, nowMs, { guaranteeEstimates })}
                  </p>

                  <div className="flex flex-col gap-2.5">
                    <p id={meaningId} className="max-w-prose text-sm text-secondary-text">
                      {PRICE_LABEL_MEANING[option.price.label]}
                    </p>

                    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                      <div className="min-w-0">
                        <dt className="text-xs text-secondary-text">Rate</dt>
                        <dd className="tabular-nums break-words">
                          1 {sourceAsset} = {formatAmount(option.price.rate)} {dest}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-secondary-text">Fees</dt>
                        <dd className="tabular-nums break-words">{formatMoney(option.fees)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-secondary-text">Track record</dt>
                        <dd className="tabular-nums">
                          {Math.round(Math.min(1, Math.max(0, option.reliability)) * 100)}%
                        </dd>
                      </div>
                    </dl>

                    {option.reasons.length > 0 && (
                      <div className="text-sm">
                        <p className="text-xs text-secondary-text">Why it ranks here</p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5">
                          {option.reasons.map((reason, i) => (
                            <li key={`${i}-${reason}`} className="break-words">
                              {plainReason(reason)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              </label>
            </li>
          );
        })}
      </ol>
    </fieldset>
  );
}
