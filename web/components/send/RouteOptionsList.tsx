"use client";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PRICE_LABELS, type PriceLabel, type RouteOption } from "@/lib/send";

interface RouteOptionsListProps {
  options: RouteOption[];
  selectedRouteId?: string;
  onSelectRoute: (route: RouteOption) => void;
}

export function RouteOptionsList({
  options,
  selectedRouteId,
  onSelectRoute,
}: RouteOptionsListProps) {
  if (options.length === 0) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-secondary-text">
          No route options found for the specified amount and destination.
        </p>
      </Card>
    );
  }

  function getBadgeVariant(label: PriceLabel): "success" | "info" | "warning" {
    switch (label) {
      case "locked":
        return "success";
      case "indicative":
        return "info";
      case "estimated":
        return "warning";
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-primary-text">
          2. Route Options
        </h2>
        <p className="mt-1 text-xs text-secondary-text">
          Ranked routes from the router. Price labels follow RFC 0004 §2 and are never merged or
          hidden.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3.5" aria-label="Route options">
        {options.map((option, index) => {
          const isSelected = option.id === selectedRouteId;
          const meta = PRICE_LABELS[option.label];
          const badgeVariant = getBadgeVariant(option.label);

          return (
            <label
              key={option.id}
              aria-label={`Select route option ${option.anchorName} (${option.label})`}
              className="block cursor-pointer"
            >
              <span className="sr-only">
                Select route {option.anchorName} with {option.label} price
              </span>
              <input
                type="radio"
                name="route-selection"
                value={option.id}
                checked={isSelected}
                onChange={() => onSelectRoute(option)}
                className="sr-only"
              />
              <Card
                selected={isSelected}
                className="transition-all hover:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500"
              >
                <div className="flex flex-col gap-3">
                  {/* Header row: Rank, Anchor Name, and distinct Price Label Badge */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-subtle text-xs font-semibold text-secondary-text">
                        {index + 1}
                      </span>
                      <span className="font-semibold text-primary-text">{option.anchorName}</span>
                    </div>

                    {/* Price Label Badge: exact RFC 0004 §2 label, never merged or hidden */}
                    <div className="flex items-center gap-1.5">
                      <Badge variant={badgeVariant}>
                        {option.label}
                      </Badge>
                    </div>
                  </div>

                  {/* Amounts & Rates Grid */}
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <div>
                      <span className="text-secondary-text">Recipient Gets:</span>
                      <div className="text-sm font-bold text-primary-text">
                        {option.destAmount} {option.destCurrency}
                      </div>
                    </div>
                    <div>
                      <span className="text-secondary-text">Exchange Rate:</span>
                      <div className="font-medium text-primary-text">{option.exchangeRate}</div>
                    </div>
                    <div>
                      <span className="text-secondary-text">Estimated Fee:</span>
                      <div className="font-medium text-primary-text">{option.fee}</div>
                    </div>
                    <div>
                      <span className="text-secondary-text">Delivery Speed:</span>
                      <div className="font-medium text-primary-text">{option.estimatedDelivery}</div>
                    </div>
                  </div>

                  {/* RFC 0004 §2 Tier Description */}
                  <div className="rounded-lg bg-bg-subtle p-2 text-xs text-secondary-text">
                    <span className="font-medium text-primary-text">{meta.title}: </span>
                    {meta.description}
                  </div>

                  {/* Reasons List */}
                  {option.reasons && option.reasons.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-secondary-text">
                      <span className="font-medium text-primary-text">Routing reasons:</span>
                      {option.reasons.map((reason, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center rounded-md bg-border/40 px-2 py-0.5 text-xs text-secondary-text"
                        >
                          {reason}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </label>
          );
        })}
      </div>
    </div>
  );
}
