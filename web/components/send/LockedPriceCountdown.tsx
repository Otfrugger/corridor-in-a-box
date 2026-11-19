"use client";

import { useEffect, useState } from "react";
import { Clock, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  formatRemainingSeconds,
  type RouteOption,
} from "@/lib/send";

interface LockedPriceCountdownProps {
  route: RouteOption;
  onRefreshQuote?: () => void;
  onExpireChange?: (isExpired: boolean) => void;
}

export function LockedPriceCountdown({
  route,
  onRefreshQuote,
  onExpireChange,
}: LockedPriceCountdownProps) {
  const isLocked = route.label === "locked";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLocked || !route.expiresAt) return;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [isLocked, route.expiresAt]);

  const expiryMs = isLocked && route.expiresAt ? new Date(route.expiresAt).getTime() : 0;
  const remainingSecs = expiryMs > now ? Math.floor((expiryMs - now) / 1000) : 0;
  const expired = isLocked && expiryMs > 0 && expiryMs <= now;

  useEffect(() => {
    onExpireChange?.(expired);
  }, [expired, onExpireChange]);

  if (!isLocked) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-secondary-text">
        <Clock size={15} className="text-secondary-text" />
        <span>
          {route.label === "indicative"
            ? "Indicative price — final rate confirmed upon settlement."
            : "Estimated price — based on historical rates."}
        </span>
      </div>
    );
  }

  if (expired) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
      >
        <div className="flex items-center gap-2 text-xs font-semibold">
          <AlertTriangle size={16} className="text-red-600 dark:text-red-400" />
          <span>Locked price expired. Expired quotes cannot be sent.</span>
        </div>

        {onRefreshQuote && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onRefreshQuote}
            className="flex items-center gap-1.5 text-xs font-medium"
          >
            <RefreshCw size={13} />
            <span>Get a new price</span>
          </Button>
        )}
      </div>
    );
  }

  const isWarning = remainingSecs <= 15;

  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-3 py-2.5 transition-colors ${
        isWarning
          ? "border-yellow-400 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/30"
          : "border-green-300 bg-green-50 dark:border-green-900/40 dark:bg-green-950/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <Clock
          size={16}
          className={isWarning ? "text-yellow-600 dark:text-yellow-400" : "text-green-600 dark:text-green-400"}
        />
        <div className="flex flex-col">
          <span className="text-xs font-medium text-primary-text">
            Guaranteed Rate Locked
          </span>
          <span className="text-[11px] text-secondary-text">
            SEP-38 firm quote expires when the countdown reaches zero.
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant={isWarning ? "warning" : "success"}>
          <span className="font-mono text-xs font-bold tracking-wider">
            {formatRemainingSeconds(remainingSecs)}
          </span>
        </Badge>
      </div>
    </div>
  );
}
