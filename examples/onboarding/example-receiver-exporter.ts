// example-receiver-exporter — a reference OnboardingExporter for a fictional
// receiver, "Example Receiver Ltd". Its onboarding form uses snake_case field
// names, one free-text address line and a single compliance contact. Copy this
// file when adding an exporter for a real receiver (see
// docs/onboarding-exporters.md).

import { err, ok } from "@corridor/types";
import type { BusinessProfile, OnboardingExporter, ReceiverForm } from "@corridor/adapter-kit";

export const exampleReceiverExporter: OnboardingExporter = {
  id: "example-receiver",
  receiver: "Example Receiver Ltd",
  export(profile: BusinessProfile) {
    const contact =
      profile.contacts.find((c) => c.role === "compliance") ??
      profile.contacts.find((c) => c.role === "primary");
    if (!contact) {
      return err({
        code: "PROFILE_INCOMPLETE",
        message: "Example Receiver requires a compliance or primary contact",
      });
    }
    const { address } = profile;
    const form: Record<string, string> = {
      company_name: profile.legalName,
      registration_no: profile.registrationNumber,
      country_of_incorporation: profile.country,
      registered_address: [
        address.line1,
        address.line2,
        address.city,
        address.region,
        address.postalCode,
      ]
        .filter(Boolean)
        .join(", "),
      address_country: address.country,
      contact_name: contact.name,
      contact_email: contact.email,
    };
    const missing = Object.keys(form).filter((field) => !form[field]?.trim());
    if (!address.line1.trim() || !address.city.trim()) missing.push("registered_address");
    if (missing.length > 0) {
      return err({
        code: "PROFILE_INCOMPLETE",
        message: `Example Receiver requires ${[...new Set(missing)].join(", ")}`,
      });
    }
    if (profile.tradingName) form.trading_as = profile.tradingName;
    if (contact.phone) form.contact_phone = contact.phone;
    return ok<ReceiverForm>(form);
  },
};
