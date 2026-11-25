import { clsx } from "clsx";

// Shared look for the send app's inputs. Focus uses the global :focus-visible
// outline in globals.css (the accent token), so nothing here removes it.

export function inputClass(invalid: boolean, extra?: string): string {
  return clsx(
    "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm text-primary-text transition-colors",
    invalid ? "border-red-600 dark:border-red-400" : "border-border hover:border-secondary-text/60",
    extra,
  );
}

export const labelClass = "text-sm font-medium text-primary-text";
export const hintClass = "text-xs leading-relaxed text-secondary-text";
export const errorClass = "text-xs font-medium text-red-700 dark:text-red-400";
