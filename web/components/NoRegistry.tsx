import { NETWORK_LABEL, type NetworkId } from "@/lib/network";

/** Where the plan for deploying the registry to a network that has none is written down. */
export const DEPLOYMENT_PLAN_URL =
  "https://github.com/corridor-in-a-box/corridor-in-a-box/blob/main/docs/mainnet-registry.md";

/**
 * The empty state for a network that has no registry.
 *
 * Kept apart from "the registry could not be read" and "the registry is empty": here there
 * is no contract to ask, so nothing was asked, and the page makes no claim about any anchor.
 */
export function NoRegistry({ network }: { network: NetworkId }) {
  const label = NETWORK_LABEL[network];
  return (
    <div className="rounded-xl border border-dashed border-border bg-bg-subtle p-5 text-sm text-secondary-text">
      <div className="mb-1 font-medium text-primary-text">No registry on {label} yet</div>
      Nothing has been attested on {label}, so there is nothing to show for it: no anchors, no
      ledger and no counts. This is not a failed read, and it says nothing about any anchor. The
      registry will be deployed there once{" "}
      <a
        href={DEPLOYMENT_PLAN_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline"
      >
        its entry criteria
        <span className="sr-only"> (opens in a new tab)</span>
      </a>{" "}
      are met.
    </div>
  );
}
