"use client";

import { useId, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { validateSendAmount } from "@/lib/send";

export interface AmountDestinationValues {
  amount: string;
  sourceAsset: string;
  destCountry: string;
  destCurrency: string;
}

interface AmountDestinationFormProps {
  initialValues?: Partial<AmountDestinationValues>;
  onSubmit: (values: AmountDestinationValues) => void;
  isLoading?: boolean;
}

const COUNTRIES = [
  { code: "US", name: "United States (USD)", currency: "USD" },
  { code: "NG", name: "Nigeria (NGN)", currency: "NGN" },
  { code: "MX", name: "Mexico (MXN)", currency: "MXN" },
  { code: "ZA", name: "South Africa (ZAR)", currency: "ZAR" },
  { code: "CN", name: "China (CNY)", currency: "CNY" },
];

const SOURCE_ASSETS = ["USDC", "XLM"];

export function AmountDestinationForm({
  initialValues,
  onSubmit,
  isLoading,
}: AmountDestinationFormProps) {
  const [amount, setAmount] = useState(initialValues?.amount ?? "100.00");
  const [sourceAsset, setSourceAsset] = useState(initialValues?.sourceAsset ?? "USDC");
  const [destCountry, setDestCountry] = useState(initialValues?.destCountry ?? "NG");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const uid = useId();
  const ids = {
    amount: `${uid}-amount`,
    amountError: `${uid}-amount-error`,
    sourceAsset: `${uid}-source-asset`,
    destCountry: `${uid}-dest-country`,
    destCurrency: `${uid}-dest-currency`,
  };

  const selectedCountry = COUNTRIES.find((c) => c.code === destCountry) ?? COUNTRIES[0];

  function handleAmountChange(val: string) {
    setAmount(val);
    if (touched) {
      const check = validateSendAmount(val);
      setAmountError(check.valid ? null : (check.error ?? "Invalid amount"));
    }
  }

  function handleBlur() {
    setTouched(true);
    const check = validateSendAmount(amount);
    setAmountError(check.valid ? null : (check.error ?? "Invalid amount"));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    const check = validateSendAmount(amount);
    if (!check.valid) {
      setAmountError(check.error ?? "Invalid amount");
      return;
    }
    setAmountError(null);
    onSubmit({
      amount,
      sourceAsset,
      destCountry,
      destCurrency: selectedCountry.currency,
    });
  }

  return (
    <Card className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-primary-text">
          1. Amount &amp; Destination
        </h2>
        <p className="mt-1 text-xs text-secondary-text">
          Specify how much you are sending and where the funds should be delivered.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Amount input */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.amount} className="text-xs font-medium text-secondary-text">
              Send Amount
            </label>
            <div className="relative">
              <input
                id={ids.amount}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => handleAmountChange(e.target.value)}
                onBlur={handleBlur}
                aria-invalid={amountError !== null}
                aria-describedby={amountError ? ids.amountError : undefined}
                className={`w-full rounded-lg border px-3 py-2 text-sm bg-background text-primary-text transition-colors focus:outline-none focus:ring-2 ${
                  amountError
                    ? "border-red-500 focus:ring-red-500/30"
                    : "border-border focus:ring-blue-500/30"
                }`}
                placeholder="0.00"
              />
            </div>
            {amountError && (
              <p id={ids.amountError} role="alert" className="text-xs font-medium text-red-500">
                {amountError}
              </p>
            )}
          </div>

          {/* Source Asset */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.sourceAsset} className="text-xs font-medium text-secondary-text">
              Source Asset
            </label>
            <select
              id={ids.sourceAsset}
              value={sourceAsset}
              onChange={(e) => setSourceAsset(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary-text focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              {SOURCE_ASSETS.map((asset) => (
                <option key={asset} value={asset}>
                  {asset} (Stellar Testnet)
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Destination Country */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.destCountry} className="text-xs font-medium text-secondary-text">
              Destination Country
            </label>
            <select
              id={ids.destCountry}
              value={destCountry}
              onChange={(e) => setDestCountry(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary-text focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              {COUNTRIES.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </div>

          {/* Destination Currency (Derived) */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.destCurrency} className="text-xs font-medium text-secondary-text">
              Payout Currency
            </label>
            <input
              id={ids.destCurrency}
              type="text"
              readOnly
              value={selectedCountry.currency}
              className="w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-secondary-text cursor-not-allowed"
            />
          </div>
        </div>

        <div className="pt-2">
          <Button type="submit" variant="primary" disabled={isLoading} className="w-full sm:w-auto">
            {isLoading ? "Finding Routes..." : "Find Route Options"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
