"use client";

import { useState } from "react";
import { Send, CheckCircle2, ShieldAlert, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AmountDestinationForm, type AmountDestinationValues } from "./AmountDestinationForm";
import { RouteOptionsList } from "./RouteOptionsList";
import { LockedPriceCountdown } from "./LockedPriceCountdown";
import { RecipientDetailsForm } from "./RecipientDetailsForm";
import {
  findRouteOptions,
  validateReceiverFields,
  validateSendAmount,
  type RouteOption,
} from "@/lib/send";

export function SendApp() {
  const [formValues, setFormValues] = useState<AmountDestinationValues>({
    amount: "100.00",
    sourceAsset: "USDC",
    destCountry: "NG",
    destCurrency: "NGN",
  });

  const [routeOptions, setRouteOptions] = useState<RouteOption[]>(() =>
    findRouteOptions({
      amount: "100.00",
      sourceAsset: "USDC",
      destCountry: "NG",
      destCurrency: "NGN",
    }),
  );

  const [selectedRoute, setSelectedRoute] = useState<RouteOption | null>(() =>
    routeOptions.length > 0 ? routeOptions[0] : null,
  );

  const [recipientValues, setRecipientValues] = useState<Record<string, string>>({});
  const [recipientErrors, setRecipientErrors] = useState<Record<string, string>>({});
  const [isQuoteExpiredState, setIsQuoteExpiredState] = useState<boolean>(false);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [sentSuccess, setSentSuccess] = useState<{
    txHash: string;
    amount: string;
    destAmount: string;
    anchorName: string;
  } | null>(null);

  function handleFormSubmit(values: AmountDestinationValues) {
    setFormValues(values);
    const options = findRouteOptions(values);
    setRouteOptions(options);
    const newSelected = options.length > 0 ? options[0] : null;
    setSelectedRoute(newSelected);
    // Changing the search resets the recipient fields
    setRecipientValues({});
    setRecipientErrors({});
    setIsQuoteExpiredState(false);
    setSentSuccess(null);
  }

  function handleSelectRoute(route: RouteOption) {
    setSelectedRoute(route);
    // Changing the route changes the fields! Clear previous route-specific values
    setRecipientValues({});
    setRecipientErrors({});
    setIsQuoteExpiredState(false);
  }

  function handleRefreshQuotes() {
    const options = findRouteOptions(formValues);
    setRouteOptions(options);
    if (selectedRoute) {
      const match = options.find((o) => o.id === selectedRoute.id) ?? options[0];
      setSelectedRoute(match);
    }
    setIsQuoteExpiredState(false);
  }

  function handleSendPayment() {
    if (!selectedRoute) return;

    // Validate amount
    const amountCheck = validateSendAmount(formValues.amount);
    if (!amountCheck.valid) return;

    // Validate recipient fields
    const recipientCheck = validateReceiverFields(
      selectedRoute.receiverFields,
      recipientValues,
    );
    if (!recipientCheck.valid) {
      setRecipientErrors(recipientCheck.errors);
      return;
    }

    // Strictly enforce: expired quotes cannot be sent
    if (isQuoteExpiredState) {
      return;
    }

    setIsSending(true);

    // Simulate sending payment across the chosen corridor
    setTimeout(() => {
      setIsSending(false);
      setSentSuccess({
        txHash: `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
        amount: `${formValues.amount} ${formValues.sourceAsset}`,
        destAmount: `${selectedRoute.destAmount} ${selectedRoute.destCurrency}`,
        anchorName: selectedRoute.anchorName,
      });
    }, 1200);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Permanent, un-dismissible Testnet Banner (RFC 0004 §6, #684) */}
      <section
        aria-label="Testnet Notice"
        className="flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 shadow-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
      >
        <ShieldAlert size={20} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="text-xs">
          <p className="font-semibold">Testnet only — no real money</p>
          <p className="text-amber-800 dark:text-amber-400/90">
            This reference send application exercises <code>@corridor/service</code> on the Stellar
            Testnet. No real fiat or cryptocurrency is transferred.
          </p>
        </div>
      </section>

      {sentSuccess ? (
        <Card className="flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400">
            <CheckCircle2 size={28} />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-primary-text">
              Payment Completed on Testnet
            </h2>
            <p className="mt-1 text-sm text-secondary-text">
              Sent {sentSuccess.amount} to {sentSuccess.destAmount} via {sentSuccess.anchorName}.
            </p>
          </div>

          <div className="rounded-lg bg-bg-subtle p-3 text-xs font-mono text-secondary-text max-w-md break-all">
            Stellar Tx Hash: {sentSuccess.txHash}
          </div>

          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setSentSuccess(null);
              handleRefreshQuotes();
            }}
            className="flex items-center gap-2"
          >
            <RotateCcw size={15} />
            <span>Start Another Payment</span>
          </Button>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Step 1: Amount & Destination Form (Issue #685) */}
          <AmountDestinationForm
            initialValues={formValues}
            onSubmit={handleFormSubmit}
          />

          {/* Step 2: Route Options List with RFC 0004 §2 Labels & Reasons (Issue #686) */}
          {routeOptions.length > 0 && (
            <RouteOptionsList
              options={routeOptions}
              selectedRouteId={selectedRoute?.id}
              onSelectRoute={handleSelectRoute}
            />
          )}

          {/* Step 3: Countdown for Locked Prices (#687) & Dynamic Recipient Details Form (#688) */}
          {selectedRoute && (
            <div className="flex flex-col gap-5">
              {/* Countdown timer for locked quotes (disabled when expired) */}
              <LockedPriceCountdown
                route={selectedRoute}
                onRefreshQuote={handleRefreshQuotes}
                onExpireChange={setIsQuoteExpiredState}
              />

              {/* Dynamic Recipient Fields driven by the chosen anchor's schema */}
              <RecipientDetailsForm
                anchorName={selectedRoute.anchorName}
                fields={selectedRoute.receiverFields}
                values={recipientValues}
                errors={recipientErrors}
                onChange={(vals) => {
                  setRecipientValues(vals);
                  if (Object.keys(recipientErrors).length > 0) {
                    setRecipientErrors({});
                  }
                }}
              />

              {/* Action area: Send button */}
              <Card className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-5">
                <div>
                  <div className="text-sm font-semibold text-primary-text">
                    Send {formValues.amount} {formValues.sourceAsset}
                  </div>
                  <div className="text-xs text-secondary-text">
                    Recipient receives ~{selectedRoute.destAmount} {selectedRoute.destCurrency} via{" "}
                    {selectedRoute.anchorName}
                  </div>
                </div>

                <div className="flex flex-col sm:items-end gap-1.5">
                  <Button
                    type="button"
                    variant="primary"
                    disabled={isQuoteExpiredState || isSending}
                    onClick={handleSendPayment}
                    className="flex items-center justify-center gap-2"
                  >
                    <Send size={15} />
                    <span>
                      {isSending
                        ? "Sending Payment..."
                        : isQuoteExpiredState
                        ? "Quote Expired"
                        : "Send Testnet Payment"}
                    </span>
                  </Button>

                  {isQuoteExpiredState && (
                    <span className="text-xs font-medium text-red-500">
                      Expired quotes cannot be sent. Please refresh rates.
                    </span>
                  )}
                </div>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
