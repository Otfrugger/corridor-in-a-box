import { TriangleAlert } from "lucide-react";

/**
 * Permanent testnet notice for the send app (RFC 0004 §6, issue #684).
 *
 * Rendered by `web/app/send/layout.tsx`, so it is on every screen under
 * `/send`. It has no close control and no client state: there is nothing a
 * user can do to hide it.
 */
export function TestnetBanner() {
  return (
    <aside
      role="note"
      aria-label="Testnet notice"
      className="flex w-full items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
      <div className="min-w-0 text-sm leading-relaxed">
        <p className="font-semibold">Testnet only. No real money.</p>
        <p className="mt-0.5 text-amber-900 dark:text-amber-200/90">
          This app sends payments on the Stellar test network through{" "}
          <code className="break-all">@corridor/service</code>. Every balance and payment here
          uses test tokens with no value.
        </p>
      </div>
    </aside>
  );
}
