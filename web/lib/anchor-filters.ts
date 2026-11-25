// Filters for the attested-anchor list: SEP, received asset, declared country and a domain
// search (#668). Pure, so the matching and the URL shapes are tested without rendering
// anything (tests/web-anchor-filters.test.ts).
//
// The filter state lives in the URL beside `?network=`, so a filtered view can be linked to.

import type { AnchorAttestation } from "./registry";

export interface AnchorFilters {
  /** A SEP number the toml advertises, or `31-served` for "advertises SEP-31 and passed its probe". */
  sep: string;
  /** An asset code the anchor's SEP-31 /info listed as receivable when it was probed. */
  asset: string;
  /** An ISO 3166-1 alpha-2 country the anchor declares. */
  country: string;
  /** Text to look for in the domain. */
  q: string;
}

export const FILTER_KEYS = ["sep", "asset", "country", "q"] as const;

export const EMPTY_FILTERS: AnchorFilters = { sep: "", asset: "", country: "", q: "" };

/** The SEP choices, in the order the select lists them. */
export const SEP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "31-served", label: "SEP-31, probed and working" },
  { value: "31", label: "SEP-31 advertised" },
  { value: "38", label: "SEP-38 quotes" },
  { value: "24", label: "SEP-24 hosted transfer" },
  { value: "6", label: "SEP-6 transfer" },
  { value: "12", label: "SEP-12 KYC" },
  { value: "10", label: "SEP-10 auth" },
];

export function parseFilters(search: string): AnchorFilters {
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key)?.trim() ?? "";
  return { sep: get("sep"), asset: get("asset"), country: get("country").toUpperCase(), q: get("q") };
}

/** The query string for `filters`, built from the current one so `?network=` survives. */
export function filterSearch(current: string, filters: AnchorFilters): string {
  const params = new URLSearchParams(current);
  for (const key of FILTER_KEYS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function hasFilters(filters: AnchorFilters): boolean {
  return FILTER_KEYS.some((key) => filters[key].trim() !== "");
}

export function matchesFilters(anchor: AnchorAttestation, filters: AnchorFilters): boolean {
  if (filters.sep === "31-served") {
    if (!anchor.servesSep31) return false;
  } else if (filters.sep) {
    const sep = Number(filters.sep);
    if (!Number.isInteger(sep) || !anchor.seps.includes(sep)) return false;
  }
  if (filters.asset && !(anchor.receiveAssets ?? []).includes(filters.asset)) return false;
  if (filters.country && !(anchor.countries ?? []).includes(filters.country)) return false;
  if (filters.q && !anchor.domain.toLowerCase().includes(filters.q.toLowerCase())) return false;
  return true;
}

/** The distinct received assets and declared countries across `anchors`, sorted, for the selects. */
export function filterChoices(anchors: readonly AnchorAttestation[]): {
  assets: string[];
  countries: string[];
} {
  const assets = new Set<string>();
  const countries = new Set<string>();
  for (const a of anchors) {
    for (const asset of a.receiveAssets ?? []) assets.add(asset);
    for (const country of a.countries ?? []) countries.add(country);
  }
  return { assets: [...assets].sort(), countries: [...countries].sort() };
}
