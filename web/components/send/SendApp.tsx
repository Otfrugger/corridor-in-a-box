"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SendErrorState } from "@/components/SendErrorState";
import type { SendErrorInput } from "@/lib/send-errors";
import {
  isQuoteExpired,
  plainReason,
  routeKey,
  sendBlockedBy,
  splitReceiverValues,
  toRouteRequest,
  validateReceiverFields,
  type Destination,
  type LoadReceiverFields,
  type PlanRoutes,
  type PlannedRoutes,
  type ReceiverField,
  type RouteOption,
  type RouteRequest,
  type SendPayment,
} from "@/lib/send";
import { AmountDestinationForm, type AmountDestinationValues } from "./AmountDestinationForm";
import { LockedPriceCountdown } from "./LockedPriceCountdown";
import { RecipientDetailsForm, fieldInputId, type FieldsStatus } from "./RecipientDetailsForm";
import { RouteOptionsList } from "./RouteOptionsList";

export interface SendAppProps {
  destinations: readonly Destination[];
  sourceAssets: readonly string[];
  /**
   * Where routes come from. @corridor/service has no route planning endpoint
   * yet, so this is injected; without it the app says so instead of showing
   * made-up routes. A browser implementation must go through /api/send/...
   */
  planRoutes?: PlanRoutes;
  /** Where the chosen route's recipient fields come from (the anchor's /sep31/info and SEP-12). */
  loadReceiverFields?: LoadReceiverFields;
  /** Sends the chosen payment, through /api/send/payments. Without it, Send stays off. */
  sendPayment?: SendPayment;
  /** Whether the business pays out estimated prices in full (RFC 0004 D4); changes the wording. */
  guaranteeEstimates?: boolean;
}

type PlanState =
  | { status: "idle" }
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; planned: PlannedRoutes };

type SendState = "idle" | "sending" | "sent" | "failed";

/** Why Send can't go ahead, judged by the clock at the moment of the click rather than the last tick. */
function blockedAtClick(input: Omit<Parameters<typeof sendBlockedBy>[0], "nowMs">) {
  return sendBlockedBy({ ...input, nowMs: Date.now() });
}

/** Ticks once a second while `active`, so every countdown and the Send button share one clock. */
function useNow(active: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return [now, () => setNow(Date.now())];
}

export function SendApp({
  destinations,
  sourceAssets,
  planRoutes,
  loadReceiverFields,
  sendPayment,
  guaranteeEstimates,
}: SendAppProps) {
  const uid = useId();
  const amountId = `${uid}-amount`;
  const fieldPrefix = `${uid}-recipient`;

  const [request, setRequest] = useState<RouteRequest | null>(null);
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [fieldsStatus, setFieldsStatus] = useState<FieldsStatus>("loading");
  const [fields, setFields] = useState<ReceiverField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendState, setSendState] = useState<SendState>("idle");

  // Answers that arrive after the sender has moved on are dropped.
  const planSeq = useRef(0);
  const fieldsSeq = useRef(0);

  const options = plan.status === "ready" ? plan.planned.options : [];
  const selected = options.find((o) => routeKey(o) === selectedKey) ?? null;
  const [nowMs, syncNow] = useNow(options.some((o) => o.price.label === "locked"));

  const loadFields = useCallback(
    async (option: RouteOption) => {
      const seq = ++fieldsSeq.current;
      setFields([]);
      setValues({});
      setErrors({});
      if (!loadReceiverFields) {
        setFieldsStatus("unavailable");
        return;
      }
      setFieldsStatus("loading");
      try {
        const loaded = await loadReceiverFields(option);
        if (seq !== fieldsSeq.current) return;
        setFields(loaded);
        setFieldsStatus("ready");
      } catch {
        if (seq !== fieldsSeq.current) return;
        setFieldsStatus("error");
      }
    },
    [loadReceiverFields],
  );

  function selectRoute(option: RouteOption) {
    if (routeKey(option) === selectedKey) return;
    setSelectedKey(routeKey(option));
    setSendState("idle");
    // A different route has a different anchor with its own requirements.
    void loadFields(option);
  }

  async function runPlan(next: RouteRequest) {
    const seq = ++planSeq.current;
    // Fields still loading for the previous plan's route are no longer wanted.
    fieldsSeq.current += 1;
    setRequest(next);
    setSelectedKey(undefined);
    setSendState("idle");
    if (!planRoutes) {
      setPlan({ status: "unavailable" });
      return;
    }
    setPlan({ status: "loading" });
    try {
      const planned = await planRoutes(next);
      if (seq !== planSeq.current) return;
      setPlan({ status: "ready", planned });
      syncNow();
      const best = planned.options[0];
      if (best) {
        setSelectedKey(routeKey(best));
        void loadFields(best);
      }
    } catch {
      if (seq !== planSeq.current) return;
      setPlan({ status: "error" });
    }
  }

  function handleSubmit(form: AmountDestinationValues) {
    void runPlan(toRouteRequest(form));
  }

  function refresh() {
    if (request) void runPlan(request);
  }

  function focusAmount() {
    document.getElementById(amountId)?.focus();
  }

  async function handleSend() {
    if (!request || !sendPayment) return;
    const block = blockedAtClick({ option: selected, fields, values });
    if (block === "quote_expired") {
      syncNow();
      return;
    }
    if (block === "fields_invalid") {
      const { errors: found } = validateReceiverFields(fields, values);
      setErrors(found);
      const first = fields.find((f) => found[f.name]);
      if (first) document.getElementById(fieldInputId(fieldPrefix, first.name))?.focus();
      return;
    }
    if (block !== null || !selected) return;
    setSendState("sending");
    try {
      await sendPayment({ request, option: selected, ...splitReceiverValues(fields, values) });
      setSendState("sent");
    } catch {
      setSendState("failed");
    }
  }

  const expired = selected !== null && isQuoteExpired(selected, nowMs);
  const sendDisabled =
    !sendPayment ||
    !selected ||
    expired ||
    fieldsStatus !== "ready" ||
    sendState === "sending" ||
    sendState === "sent";

  let noRoutes: SendErrorInput | null = null;
  if (plan.status === "ready" && options.length === 0) {
    const dropped = (plan.planned.dropped ?? []).map((d) => ({
      route: d.route,
      reason: plainReason(d.reason),
    }));
    noRoutes = dropped.length > 0 ? { kind: "all_routes_dropped", dropped } : { kind: "no_routes" };
  }

  return (
    <div className="flex flex-col gap-10">
      <AmountDestinationForm
        destinations={destinations}
        sourceAssets={sourceAssets}
        amountId={amountId}
        onSubmit={handleSubmit}
        busy={plan.status === "loading"}
      />

      <div aria-live="polite" className="sr-only">
        {plan.status === "loading" ? "Finding routes." : ""}
        {plan.status === "ready" && options.length > 0
          ? `${options.length} ${options.length === 1 ? "route" : "routes"} found.`
          : ""}
      </div>

      {plan.status === "unavailable" && (
        <section className="rounded-xl border border-border bg-bg-subtle px-5 py-4">
          <h2 className="font-semibold">Routes can't be listed here yet</h2>
          <p className="mt-1 max-w-prose text-sm text-secondary-text">
            Your amount and destination are fine. The service this app runs on does not plan routes
            yet, so there are no prices to compare. Nothing has been sent.
          </p>
        </section>
      )}

      {plan.status === "loading" && (
        <div className="flex flex-col gap-3" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-bg-subtle" />
          ))}
        </div>
      )}

      {plan.status === "error" && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-subtle px-5 py-4"
        >
          <p className="text-sm">Couldn't get routes right now.</p>
          <Button type="button" variant="secondary" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}

      {noRoutes && <SendErrorState error={noRoutes} onAction={focusAmount} />}

      {options.length > 0 && request && (
        <RouteOptionsList
          options={options}
          selectedKey={selectedKey}
          onSelect={selectRoute}
          nowMs={nowMs}
          sourceAsset={request.sourceAmount.asset}
          guaranteeEstimates={guaranteeEstimates}
        />
      )}

      {selected && (
        <>
          <LockedPriceCountdown option={selected} nowMs={nowMs} onRefresh={refresh} />

          <RecipientDetailsForm
            anchor={selected.receivingDomain}
            status={fieldsStatus}
            fields={fields}
            values={values}
            errors={errors}
            idPrefix={fieldPrefix}
            onRetry={() => void loadFields(selected)}
            onChange={(name, value) => {
              setValues((v) => ({ ...v, [name]: value }));
              if (errors[name]) {
                setErrors((e) => {
                  const rest = { ...e };
                  delete rest[name];
                  return rest;
                });
              }
            }}
          />

          <section
            aria-label="Send"
            className="flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-secondary-text">
              {expired
                ? "The locked price has expired, so this payment can't be sent. Get a new price first."
                : !sendPayment
                  ? "Sending isn't connected in this build yet."
                  : "Test tokens only. Nothing here has real value."}
            </p>
            <Button
              type="button"
              size="lg"
              disabled={sendDisabled}
              onClick={() => void handleSend()}
              className="shrink-0 active:translate-y-px"
            >
              <Send size={16} aria-hidden />
              {sendState === "sending" ? "Sending…" : "Send"}
            </Button>
          </section>

          <div aria-live="polite">
            {sendState === "sent" && <p className="text-sm font-medium">Payment sent.</p>}
          </div>
          {sendState === "failed" && (
            <SendErrorState error={{ kind: "payment_failed" }} onAction={focusAmount} />
          )}
        </>
      )}
    </div>
  );
}
