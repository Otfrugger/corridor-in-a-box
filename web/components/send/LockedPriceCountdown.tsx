"use client";

import { clsx } from "clsx";
import { Clock } from "lucide-react";
import { SendErrorState } from "@/components/SendErrorState";
import {
  QUOTE_WARNING_SECONDS,
  formatCountdown,
  isQuoteExpired,
  quoteSecondsLeft,
  type RouteOption,
} from "@/lib/send";

interface LockedPriceCountdownProps {
  option: RouteOption;
  /** The shared clock from the send app, the same one that enables Send. */
  nowMs: number;
  /** Asks the planner again for a fresh price. */
  onRefresh?: () => void;
}

/**
 * Step 3 (#687): the time left on a locked price. Renders nothing for an
 * indicative or estimated price, which has no expiry. Once a locked price runs
 * out it gives way to the expired-price screen, and the send app disables Send.
 *
 * The digits tick every second but are not announced each time (role="timer"
 * is not a live region); the warning and the expiry are announced once.
 */
export function LockedPriceCountdown({ option, nowMs, onRefresh }: LockedPriceCountdownProps) {
  const left = quoteSecondsLeft(option, nowMs);
  if (left === undefined) return null;

  if (isQuoteExpired(option, nowMs)) {
    return <SendErrorState error={{ kind: "quote_expired" }} onAction={onRefresh} />;
  }

  const warning = left <= QUOTE_WARNING_SECONDS;
  return (
    <div
      className={clsx(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3",
        warning
          ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100"
          : "border-border bg-bg-subtle",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Clock size={16} aria-hidden className="shrink-0" />
        <p className="text-sm">
          {warning ? "This price is about to expire." : "This price is locked."}{" "}
          <span className={warning ? "" : "text-secondary-text"}>
            Send before the timer runs out.
          </span>
        </p>
      </div>
      <p
        role="timer"
        aria-label="Time left on the locked price"
        className="font-mono text-lg font-semibold tabular-nums"
      >
        {formatCountdown(left)}
      </p>
      <p aria-live="polite" className="sr-only">
        {warning ? `Less than ${QUOTE_WARNING_SECONDS} seconds left on the locked price.` : ""}
      </p>
    </div>
  );
}
