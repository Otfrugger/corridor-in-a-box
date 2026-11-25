"use client";

import { useEffect, useId, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { isTxHash, txUrl } from "@/lib/explorer";
import {
  OUTCOME_TEXT,
  STEP_TEXT,
  advance,
  isFinalState,
  outcomeOf,
  timelineSteps,
  type PaymentStatusLike,
  type TimelineOutcome,
  type TimelineStepStatus,
} from "@/lib/payment-timeline";

const POLL_MS = 2000;

const BADGE: Record<TimelineOutcome, "default" | "success" | "warning" | "danger" | "info"> = {
  in_progress: "info",
  completed: "success",
  recovering: "warning",
  refund_pending: "warning",
  refunded: "warning",
  held: "warning",
  failed: "danger",
};

const DOT: Record<TimelineStepStatus, string> = {
  done: "bg-blue-600 text-white",
  active: "border-2 border-blue-600 text-blue-600 animate-pulse",
  pending: "border border-border text-secondary-text",
  stopped: "bg-red-600 text-white",
};

/**
 * Polls GET /api/payments/:key and draws the payment as five steps, from the
 * moment it is submitted until it reaches a terminal state. While `submitting`,
 * a 404 means the run is not stored yet and is retried. `trail` and `result`
 * come from the POST response once it lands: the trail says how far a failed run
 * got, which its status alone does not, and the result is the outcome to show
 * if the status endpoint cannot see the run (another server instance's memory).
 * Once nothing is pending and the endpoint has no such run, it renders nothing.
 * Remount it (change its `key`) to watch another run.
 */
export function PaymentTimeline({
  idempotencyKey,
  submitting = false,
  trail = [],
  result,
  network = "testnet",
}: {
  idempotencyKey: string;
  submitting?: boolean;
  trail?: readonly string[];
  result?: PaymentStatusLike;
  network?: string;
}) {
  const [polled, setPolled] = useState<PaymentStatusLike | null>(null);
  const [polledProgress, setPolledProgress] = useState(0);
  const [pollError, setPollError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const headingId = useId();

  const polledFinal = polled !== null && isFinalState(polled.state);
  const resultFinal = result !== undefined && isFinalState(result.state);
  const finished = polledFinal || resultFinal;

  useEffect(() => {
    if (finished) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      let next: PaymentStatusLike | null = null;
      let retry = true;
      try {
        const res = await fetch(`/api/payments/${encodeURIComponent(idempotencyKey)}`, {
          cache: "no-store",
        });
        const body = (await res.json().catch(() => ({}))) as Partial<PaymentStatusLike> & {
          error?: string;
        };
        if (res.ok && typeof body.state === "string") {
          next = { ...body, state: body.state };
        } else if (res.status === 404 && !submitting) {
          retry = false;
          if (!cancelled) setMissing(true);
        } else if (res.status !== 404) {
          retry = res.status >= 500;
          if (!cancelled) setPollError(body.error ?? `status request failed (HTTP ${res.status})`);
        }
      } catch {
        if (!cancelled) setPollError("could not reach the status endpoint");
      }
      if (cancelled) return;
      if (next) {
        const seen = next;
        setPollError(null);
        setMissing(false);
        setPolled(seen);
        setPolledProgress((prev) => advance(prev, seen));
        retry = !isFinalState(seen.state);
      }
      if (retry) timer = setTimeout(poll, POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [idempotencyKey, submitting, finished]);

  const status = polledFinal ? polled : resultFinal ? result : (polled ?? result ?? null);
  const progress = Math.max(
    polledProgress,
    trail.reduce((reached, state) => advance(reached, { state }), 0),
    status ? advance(0, status) : 0,
  );
  const state = status?.state ?? "created";
  const outcome = outcomeOf(state);
  const steps = timelineSteps(progress, state);
  const hash = status?.stellarTxHash;

  if (missing && !status) return null;

  return (
    <Card>
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id={headingId} className="font-semibold">
            Payment progress
          </h2>
          <Badge variant={BADGE[outcome]}>{status ? state : "waiting"}</Badge>
        </div>

        <output aria-live="polite" aria-atomic="true" className="sr-only">
          {status ? `${OUTCOME_TEXT[outcome]}.` : ""}
        </output>

        <ol className="flex items-start">
          {steps.map(({ step, status: stepStatus }, i) => (
            <li key={step} className="flex flex-1 flex-col items-center gap-1.5 text-center">
              <div className="flex w-full items-center">
                <span
                  aria-hidden="true"
                  className={
                    "h-0.5 flex-1 " +
                    (i === 0 ? "invisible" : stepStatus === "pending" ? "bg-border" : "bg-blue-600")
                  }
                />
                <span
                  aria-hidden="true"
                  className={
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold " +
                    DOT[stepStatus]
                  }
                >
                  {stepStatus === "done" ? "✓" : stepStatus === "stopped" ? "!" : i + 1}
                </span>
                <span
                  aria-hidden="true"
                  className={
                    "h-0.5 flex-1 " +
                    (i === steps.length - 1
                      ? "invisible"
                      : steps[i + 1].status === "pending"
                        ? "bg-border"
                        : "bg-blue-600")
                  }
                />
              </div>
              <span
                className={
                  "font-mono text-xs " +
                  (stepStatus === "pending" ? "text-secondary-text" : "font-medium")
                }
              >
                {step}
              </span>
              <span className="sr-only">: {STEP_TEXT[stepStatus]}</span>
            </li>
          ))}
        </ol>

        {outcome !== "in_progress" && outcome !== "completed" && (
          <div
            className={
              "rounded-lg border px-3 py-2 text-sm " +
              (outcome === "failed"
                ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
                : "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-300")
            }
          >
            <span className="font-semibold">{OUTCOME_TEXT[outcome]}</span>
            {status?.error && (
              <>
                {" — "}
                <span className="font-mono">{status.error}</span>
              </>
            )}
          </div>
        )}

        {hash && (
          <div className="rounded-lg bg-bg-subtle px-3 py-2 text-xs">
            <span className="text-secondary-text">settlement tx: </span>
            {isTxHash(hash) ? (
              <a
                href={txUrl(network, hash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono break-all underline"
              >
                {hash}
                <ExternalLink size={12} aria-hidden="true" />
                <span className="sr-only">(opens stellar.expert in a new tab)</span>
              </a>
            ) : (
              <span className="font-mono break-all">{hash}</span>
            )}
          </div>
        )}

        {pollError && (
          <p className="text-xs text-red-700 dark:text-red-400">Status unavailable: {pollError}</p>
        )}
      </section>
    </Card>
  );
}
