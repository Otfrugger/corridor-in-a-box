"use client";

import { useId } from "react";
import { Card } from "@/components/ui/Card";
import type { ReceiverField } from "@/lib/send";

interface RecipientDetailsFormProps {
  anchorName: string;
  fields: ReceiverField[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

/**
 * Renders the receiver fields the chosen anchor requires (from its /sep31/info and SEP-12).
 * Strictly dynamic: no hardcoded field list. Changing the route changes the fields immediately.
 */
export function RecipientDetailsForm({
  anchorName,
  fields,
  values,
  errors,
  onChange,
}: RecipientDetailsFormProps) {
  const uid = useId();

  function handleFieldChange(name: string, val: string) {
    onChange({
      ...values,
      [name]: val,
    });
  }

  if (fields.length === 0) {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-primary-text">
          3. Recipient Details
        </h2>
        <p className="text-xs text-secondary-text">
          This anchor requires no additional receiver payout fields.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight text-primary-text">
            3. Recipient Details
          </h2>
          <span className="text-xs font-medium text-secondary-text">
            Required by <span className="text-primary-text">{anchorName}</span>
          </span>
        </div>
        <p className="mt-1 text-xs text-secondary-text">
          Fields are dynamically populated from the receiving anchor&apos;s <code>/sep31/info</code> and
          SEP-12 schema. Changing the route dynamically updates these requirements.
        </p>
      </div>

      <div className="flex flex-col gap-3.5">
        {fields.map((field) => {
          const fieldId = `${uid}-field-${field.name}`;
          const errorId = `${uid}-error-${field.name}`;
          const descId = `${uid}-desc-${field.name}`;
          const err = errors[field.name];
          const val = values[field.name] ?? "";

          return (
            <div key={field.name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label htmlFor={fieldId} className="text-xs font-medium text-secondary-text">
                  {field.label} {!field.optional && <span className="text-red-500">*</span>}
                </label>
                {field.optional && (
                  <span className="text-[11px] text-secondary-text/80 font-normal">Optional</span>
                )}
              </div>

              {field.choices && field.choices.length > 0 ? (
                <select
                  id={fieldId}
                  value={val}
                  onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  aria-invalid={!!err}
                  aria-describedby={
                    [err ? errorId : undefined, field.description ? descId : undefined]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  className={`w-full rounded-lg border bg-background px-3 py-2 text-sm text-primary-text focus:outline-none focus:ring-2 ${
                    err
                      ? "border-red-500 focus:ring-red-500/30"
                      : "border-border focus:ring-blue-500/30"
                  }`}
                >
                  <option value="">Select an option</option>
                  {field.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={fieldId}
                  type={field.type === "number" ? "number" : "text"}
                  value={val}
                  placeholder={field.placeholder ?? ""}
                  onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  aria-invalid={!!err}
                  aria-describedby={
                    [err ? errorId : undefined, field.description ? descId : undefined]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  className={`w-full rounded-lg border px-3 py-2 text-sm bg-background text-primary-text focus:outline-none focus:ring-2 ${
                    err
                      ? "border-red-500 focus:ring-red-500/30"
                      : "border-border focus:ring-blue-500/30"
                  }`}
                />
              )}

              {field.description && (
                <p id={descId} className="text-[11px] text-secondary-text">
                  {field.description}
                </p>
              )}

              {err && (
                <p id={errorId} role="alert" className="text-xs font-medium text-red-500">
                  {err}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
