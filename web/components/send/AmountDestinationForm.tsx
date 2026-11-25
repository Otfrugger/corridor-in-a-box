"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { validateSendAmount, type Destination } from "@/lib/send";
import { errorClass, hintClass, inputClass, labelClass } from "./field-styles";

export interface AmountDestinationValues {
  amount: string;
  sourceAsset: string;
  destination: Destination;
}

interface AmountDestinationFormProps {
  /** Where payments can go, read from the corridor manifests by the page. */
  destinations: readonly Destination[];
  sourceAssets: readonly string[];
  /** Lets the parent move focus back to the amount, for example from an error screen. */
  amountId: string;
  onSubmit: (values: AmountDestinationValues) => void;
  busy?: boolean;
}

const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : undefined;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Step 1 (#685): how much to send, in what, and where it should arrive. */
export function AmountDestinationForm({
  destinations,
  sourceAssets,
  amountId,
  onSubmit,
  busy,
}: AmountDestinationFormProps) {
  const uid = useId();
  const ids = {
    amountError: `${uid}-amount-error`,
    amountHint: `${uid}-amount-hint`,
    asset: `${uid}-asset`,
    country: `${uid}-country`,
    currency: `${uid}-currency`,
  };

  const countries = [...new Set(destinations.map((d) => d.country))];
  const [amount, setAmount] = useState("");
  const [sourceAsset, setSourceAsset] = useState(sourceAssets[0] ?? "");
  const [country, setCountry] = useState(countries[0] ?? "");
  const currencies = destinations.filter((d) => d.country === country).map((d) => d.currency);
  const [currency, setCurrency] = useState(currencies[0] ?? "");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const noDestinations = destinations.length === 0 || sourceAssets.length === 0;

  function check(value: string): boolean {
    const result = validateSendAmount(value);
    setAmountError(result.valid ? null : result.error);
    return result.valid;
  }

  function handleCountry(next: string) {
    setCountry(next);
    const first = destinations.find((d) => d.country === next);
    setCurrency(first?.currency ?? "");
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    const result = validateSendAmount(amount);
    if (!result.valid) {
      setAmountError(result.error);
      document.getElementById(amountId)?.focus();
      return;
    }
    setAmountError(null);
    onSubmit({ amount: result.amount, sourceAsset, destination: { country, currency } });
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-5">
      <header>
        <h2 id={`${uid}-title`} className="text-lg font-semibold tracking-tight">
          Amount and destination
        </h2>
        <p className="mt-1 max-w-prose text-sm text-secondary-text">
          How much to send, and the country and currency it should arrive in.
        </p>
      </header>

      {noDestinations ? (
        <p className="rounded-lg border border-border bg-bg-subtle px-4 py-3 text-sm text-secondary-text">
          No testnet corridor is configured, so there is nowhere to send to yet.
        </p>
      ) : (
        <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={amountId} className={labelClass}>
                Amount
              </label>
              <input
                id={amountId}
                name="amount"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  if (touched) check(e.target.value);
                }}
                onBlur={() => {
                  if (amount.trim() === "" && !touched) return;
                  setTouched(true);
                  check(amount);
                }}
                aria-invalid={amountError !== null}
                aria-describedby={amountError ? `${ids.amountError} ${ids.amountHint}` : ids.amountHint}
                className={inputClass(amountError !== null, "tabular-nums")}
                placeholder="25.00"
              />
              <p id={ids.amountHint} className={hintClass}>
                Up to 7 decimal places. Test tokens only.
              </p>
              <div aria-live="polite">
                {amountError && (
                  <p id={ids.amountError} className={errorClass}>
                    {amountError}
                  </p>
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={ids.asset} className={labelClass}>
                Send in
              </label>
              <select
                id={ids.asset}
                value={sourceAsset}
                onChange={(e) => setSourceAsset(e.target.value)}
                className={inputClass(false)}
              >
                {sourceAssets.map((asset) => (
                  <option key={asset} value={asset}>
                    {asset}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={ids.country} className={labelClass}>
                Destination country
              </label>
              <select
                id={ids.country}
                value={country}
                onChange={(e) => handleCountry(e.target.value)}
                className={inputClass(false)}
              >
                {countries.map((code) => (
                  <option key={code} value={code}>
                    {countryName(code)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={ids.currency} className={labelClass}>
                Arrives in
              </label>
              <select
                id={ids.currency}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={inputClass(false)}
              >
                {currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <Button type="submit" disabled={busy} className="active:translate-y-px">
              {busy ? "Finding routes…" : "Find routes"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
