"use client";

import { useId, useMemo, useSyncExternalStore } from "react";
import { RotateCcw, Search } from "lucide-react";
import { AnchorCard } from "@/components/AnchorCard";
import {
  EMPTY_FILTERS,
  SEP_OPTIONS,
  filterChoices,
  filterSearch,
  hasFilters,
  matchesFilters,
  parseFilters,
  type AnchorFilters,
} from "@/lib/anchor-filters";
import type { NetworkId } from "@/lib/network";
import type { AnchorAttestation } from "@/lib/registry";

/** Fired after a filter rewrites the URL, since `replaceState` raises no event of its own. */
const CHANGED = "corridor:anchor-filters-changed";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

const control =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary-text transition-colors focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/30";

/**
 * One network's attested anchors with filters for SEP, received asset, declared country and
 * domain (#668).
 *
 * Like NetworkSwitch, the filters are read from the URL with `useSyncExternalStore`, not
 * `useSearchParams`: that hook needs a Suspense boundary on a prerendered page and leaves what
 * is inside it out of the served HTML. Here the server renders every anchor unfiltered and the
 * browser applies the URL's filters once it has them.
 */
export function AttestedAnchorsSection({
  anchors,
  network,
}: {
  anchors: AnchorAttestation[];
  network: NetworkId;
}) {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
  const filters = useMemo(() => parseFilters(search), [search]);
  const choices = useMemo(() => filterChoices(anchors), [anchors]);
  const shown = useMemo(() => anchors.filter((a) => matchesFilters(a, filters)), [anchors, filters]);
  const active = hasFilters(filters);
  const id = useId();

  function update(next: AnchorFilters) {
    const { pathname, search: current, hash } = window.location;
    window.history.replaceState(null, "", `${pathname}${filterSearch(current, next)}${hash}`);
    window.dispatchEvent(new Event(CHANGED));
  }
  const set = (key: keyof AnchorFilters) => (value: string) => update({ ...filters, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      <search
        aria-label="Filter anchors"
        className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-bg-subtle p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-secondary-text">
          Domain
          <span className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-secondary-text"
            />
            <input
              type="search"
              value={filters.q}
              onChange={(e) => set("q")(e.target.value)}
              placeholder="e.g. cowrie"
              className={`${control} pl-9`}
            />
          </span>
        </label>
        <FilterSelect
          id={`${id}-sep`}
          label="SEP"
          value={filters.sep}
          onChange={set("sep")}
          options={SEP_OPTIONS}
          any="Any SEP"
        />
        <FilterSelect
          id={`${id}-asset`}
          label="Receives (probed)"
          value={filters.asset}
          onChange={set("asset")}
          options={choices.assets.map((a) => ({ value: a, label: a }))}
          any={choices.assets.length ? "Any asset" : "No receive assets attested yet"}
        />
        <FilterSelect
          id={`${id}-country`}
          label="Country (declared)"
          value={filters.country}
          onChange={set("country")}
          options={choices.countries.map((c) => ({ value: c, label: c }))}
          any="Any country"
        />
      </search>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-secondary-text">
        <p aria-live="polite">
          Showing <span className="font-semibold tabular-nums text-primary-text">{shown.length}</span>{" "}
          of <span className="tabular-nums">{anchors.length}</span> anchors
        </p>
        {active && (
          <button
            type="button"
            onClick={() => update(EMPTY_FILTERS)}
            className="inline-flex items-center gap-1 rounded font-medium text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/40"
          >
            <RotateCcw size={12} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-bg-subtle p-6 text-sm text-secondary-text">
          No anchor on this network matches these filters.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {shown.map((a) => (
            <AnchorCard key={a.domain} anchor={a} network={network} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  any,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  any: string;
}) {
  // A value from a link that no anchor here has is still shown, so the person sees why the
  // list is empty instead of a select that silently says "any".
  const listed = !value || options.some((o) => o.value === value);
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs font-medium text-secondary-text">
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={control}>
        <option value="">{any}</option>
        {!listed && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
