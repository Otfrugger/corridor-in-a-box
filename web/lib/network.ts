// Which Stellar network a number on the page comes from. Pure, so the parsing and the
// URL shapes are tested without rendering anything (tests/web-network.test.ts).

/** The networks the dashboard can read a registry from, in the order the switch lists them. */
export const NETWORKS = ["testnet", "public"] as const;

export type NetworkId = (typeof NETWORKS)[number];

/** What a person calls each one. `public` is Stellar's own name for mainnet. */
export const NETWORK_LABEL: Record<NetworkId, string> = {
  testnet: "Testnet",
  public: "Mainnet",
};

export function isNetworkId(value: unknown): value is NetworkId {
  return (NETWORKS as readonly unknown[]).includes(value);
}

/**
 * The network a `?network=` value or an env var names, or undefined when it names none.
 * `mainnet` is accepted for `public`, since that is the word people type. Anything else is
 * not guessed at: the caller falls back to its default rather than showing the wrong network.
 */
export function parseNetwork(value: string | null | undefined): NetworkId | undefined {
  const name = value?.trim().toLowerCase();
  if (name === "mainnet") return "public";
  return isNetworkId(name) ? name : undefined;
}

/**
 * The query string that selects `network`, built from the current one so other parameters
 * survive. The default network carries no parameter, which keeps the plain URL meaning what
 * it always has.
 */
export function networkSearch(current: string, network: NetworkId, fallback: NetworkId): string {
  const params = new URLSearchParams(current);
  if (network === fallback) params.delete("network");
  else params.set("network", network);
  const query = params.toString();
  return query ? `?${query}` : "";
}
