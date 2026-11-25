"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import {
  NETWORKS,
  NETWORK_LABEL,
  networkSearch,
  parseNetwork,
  type NetworkId,
} from "@/lib/network";

/** Fired after the switch rewrites the URL, since `replaceState` raises no event of its own. */
const CHANGED = "corridor:network-changed";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/**
 * Chooses which network's registry is shown.
 *
 * The page is rendered ahead of time for both networks and each panel arrives here already
 * rendered, so switching reads nothing new: it only decides which panel is on screen. The
 * choice lives in the URL (`?network=public`), not in component state, so a link to the
 * mainnet view opens the mainnet view. The server cannot see that parameter on a cached
 * page, so it renders `fallback` and the browser corrects it once it has the URL.
 *
 * The URL is read with `useSyncExternalStore` rather than `useSearchParams`: that hook needs
 * a Suspense boundary on a prerendered page, and what sits inside the boundary is left out
 * of the HTML. This way the default network's anchors are in the page as it is served.
 */
export function NetworkSwitch({
  fallback,
  panels,
}: {
  fallback: NetworkId;
  panels: Record<NetworkId, ReactNode>;
}) {
  const network = useSyncExternalStore(
    subscribe,
    () => parseNetwork(new URLSearchParams(window.location.search).get("network")) ?? fallback,
    () => fallback,
  );

  function choose(next: NetworkId) {
    const { pathname, search, hash } = window.location;
    const url = `${pathname}${networkSearch(search, next, fallback)}${hash}`;
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="inline-flex w-fit min-w-0 rounded-full border border-border bg-bg-subtle p-0.5">
        <legend className="sr-only">Registry network</legend>
        {NETWORKS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === network}
            onClick={() => choose(id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              id === network
                ? "bg-background text-primary-text shadow-sm"
                : "text-secondary-text hover:text-primary-text"
            }`}
          >
            {NETWORK_LABEL[id]}
          </button>
        ))}
      </fieldset>
      {panels[network]}
    </div>
  );
}
