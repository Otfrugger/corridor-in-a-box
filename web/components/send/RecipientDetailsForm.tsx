"use client";

import { Button } from "@/components/ui/Button";
import type { ReceiverField } from "@/lib/send";
import { errorClass, hintClass, inputClass, labelClass } from "./field-styles";

export type FieldsStatus = "loading" | "ready" | "error" | "unavailable";

interface RecipientDetailsFormProps {
  /** The receiving anchor, so the sender knows who is asking. */
  anchor: string;
  status: FieldsStatus;
  fields: readonly ReceiverField[];
  values: Readonly<Record<string, string>>;
  errors: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
  onRetry?: () => void;
  /** Prefix for input ids, so the send app can move focus to the first field with an error. */
  idPrefix: string;
}

function optionalMark(optional: boolean) {
  return optional ? (
    <span className="ml-1.5 font-normal text-secondary-text">(optional)</span>
  ) : null;
}

export function fieldInputId(idPrefix: string, name: string): string {
  return `${idPrefix}-${name}`;
}

/**
 * Step 4 (#688): the details the chosen route's anchor asks for. There is no
 * field list here: every input comes from `fields`, which the send app loads
 * from the receiving anchor for the selected route, so a different route shows
 * different fields.
 */
export function RecipientDetailsForm({
  anchor,
  status,
  fields,
  values,
  errors,
  onChange,
  onRetry,
  idPrefix,
}: RecipientDetailsFormProps) {
  const titleId = `${idPrefix}-title`;
  return (
    <section aria-labelledby={titleId} aria-busy={status === "loading"} className="flex flex-col gap-4">
      <header>
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          Recipient details
        </h2>
        <p className="mt-1 max-w-prose text-sm break-words text-secondary-text">
          Asked for by <span className="font-medium text-primary-text">{anchor}</span>. Only what
          this anchor requires, nothing more.
        </p>
      </header>

      {status === "loading" && (
        <div className="flex flex-col gap-3" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="h-4 w-32 animate-pulse rounded bg-border" />
              <div className="h-10 w-full animate-pulse rounded-lg bg-bg-subtle" />
            </div>
          ))}
        </div>
      )}
      {status === "loading" && <p className="sr-only">Loading the fields this anchor asks for.</p>}

      {status === "unavailable" && (
        <p className="rounded-lg border border-border bg-bg-subtle px-4 py-3 text-sm text-secondary-text">
          This app can't read this anchor's requirements yet, so it can't show the recipient
          fields.
        </p>
      )}

      {status === "error" && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-subtle px-4 py-3"
        >
          <p className="text-sm">Couldn't load what this anchor asks for.</p>
          {onRetry && (
            <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}

      {status === "ready" && fields.length === 0 && (
        <p className="text-sm text-secondary-text">This anchor needs no recipient details.</p>
      )}

      {status === "ready" && fields.length > 0 && (
        <div className="flex flex-col gap-4">
          {fields.map((field) => {
            const id = fieldInputId(idPrefix, field.name);
            const hintId = `${id}-hint`;
            const errorId = `${id}-error`;
            const error = errors[field.name];
            const describedBy =
              [error ? errorId : null, field.description ? hintId : null]
                .filter(Boolean)
                .join(" ") || undefined;
            const value = values[field.name] ?? "";

            return (
              <div key={field.name} className="flex min-w-0 flex-col gap-1.5">
                {field.type === "binary" ? (
                  <p id={`${id}-label`} className={labelClass}>
                    {field.label}
                    {optionalMark(field.optional)}
                  </p>
                ) : (
                  <label htmlFor={id} className={labelClass}>
                    {field.label}
                    {optionalMark(field.optional)}
                  </label>
                )}

                {field.type === "binary" ? (
                  <p
                    id={id}
                    tabIndex={-1}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={describedBy}
                    className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-secondary-text"
                  >
                    This is a document upload. This app can't send documents yet.
                  </p>
                ) : field.choices ? (
                  <select
                    id={id}
                    name={field.name}
                    value={value}
                    required={!field.optional}
                    onChange={(e) => onChange(field.name, e.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={describedBy}
                    className={inputClass(Boolean(error))}
                  >
                    <option value="">Choose…</option>
                    {field.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    name={field.name}
                    type={field.type === "date" ? "date" : "text"}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    autoComplete="off"
                    value={value}
                    required={!field.optional}
                    onChange={(e) => onChange(field.name, e.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={describedBy}
                    className={inputClass(Boolean(error))}
                  />
                )}

                {field.description && (
                  <p id={hintId} className={hintClass}>
                    {field.description}
                  </p>
                )}
                {error && (
                  <p id={errorId} className={errorClass}>
                    {error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
