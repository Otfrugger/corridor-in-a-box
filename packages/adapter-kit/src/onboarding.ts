// Onboarding exporters: until a receiver accepts a business onboarding profile
// directly, the business fills in that receiver's own form. An exporter maps
// one BusinessProfile onto one receiver's form fields. Contributors add one
// exporter per receiver and register it; see docs/onboarding-exporters.md.

import { err, ok, type Outcome } from "@corridor/types";

export interface BusinessAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region?: string;
  readonly postalCode?: string;
  /** ISO 3166-1 alpha-2, e.g. "NG". */
  readonly country: string;
}

export interface BusinessContact {
  readonly role: "primary" | "compliance" | "finance" | "technical";
  readonly name: string;
  readonly email: string;
  readonly phone?: string;
}

/** What a business tells us about itself once, for every receiver it onboards with. */
export interface BusinessProfile {
  readonly legalName: string;
  readonly tradingName?: string;
  /** Company registration number issued by the registry of `country`. */
  readonly registrationNumber: string;
  /** Country of incorporation, ISO 3166-1 alpha-2. */
  readonly country: string;
  /** ISO 8601 date, e.g. "2019-04-01". */
  readonly incorporationDate?: string;
  readonly taxId?: string;
  readonly website?: string;
  readonly address: BusinessAddress;
  readonly contacts: readonly BusinessContact[];
}

/** A receiver's onboarding form: its own field names mapped to string values. */
export type ReceiverForm = Readonly<Record<string, string>>;

export type ExporterErrorCode =
  "EXPORTER_INVALID" | "EXPORTER_DUPLICATE" | "EXPORTER_UNKNOWN" | "PROFILE_INCOMPLETE";

export interface ExporterError {
  readonly code: ExporterErrorCode;
  readonly message: string;
}

/** Maps a BusinessProfile onto one receiver's onboarding form. */
export interface OnboardingExporter {
  /** Stable registry key, `^[a-z0-9-]+$` (the same rule as `custom:<id>` adapters). */
  readonly id: string;
  /** Human-readable receiver name, for UIs and error messages. */
  readonly receiver: string;
  /** Fails with PROFILE_INCOMPLETE when the profile lacks something the form requires. */
  export(profile: BusinessProfile): Outcome<ReceiverForm, ExporterError>;
}

export interface ExporterRegistry {
  /** Add an exporter. Fails on a malformed or already-registered id. */
  register(exporter: OnboardingExporter): Outcome<void, ExporterError>;
  get(id: string): OnboardingExporter | undefined;
  /** Registered ids, in registration order. */
  ids(): readonly string[];
  /** Run the exporter registered under `id` against a profile. */
  export(id: string, profile: BusinessProfile): Outcome<ReceiverForm, ExporterError>;
}

const EXPORTER_ID = /^[a-z0-9-]+$/;

export function createExporterRegistry(): ExporterRegistry {
  const exporters = new Map<string, OnboardingExporter>();

  return {
    register(exporter) {
      if (!EXPORTER_ID.test(exporter.id)) {
        return err({
          code: "EXPORTER_INVALID",
          message: `exporter id "${exporter.id}" must match ${EXPORTER_ID}`,
        });
      }
      if (exporters.has(exporter.id)) {
        return err({
          code: "EXPORTER_DUPLICATE",
          message: `an exporter is already registered under "${exporter.id}"`,
        });
      }
      exporters.set(exporter.id, exporter);
      return ok(undefined);
    },

    get(id) {
      return exporters.get(id);
    },

    ids() {
      return [...exporters.keys()];
    },

    export(id, profile) {
      const exporter = exporters.get(id);
      if (!exporter) {
        return err({
          code: "EXPORTER_UNKNOWN",
          message: `no exporter registered under "${id}"`,
        });
      }
      return exporter.export(profile);
    },
  };
}
