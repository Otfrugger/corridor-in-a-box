import { describe, expect, it } from "vitest";
import {
  createExporterRegistry,
  type BusinessProfile,
  type OnboardingExporter,
} from "@corridor/adapter-kit";
import { ok } from "@corridor/types";
import { exampleReceiverExporter } from "../examples/onboarding/example-receiver-exporter";

const profile: BusinessProfile = {
  legalName: "Acme Trading Limited",
  tradingName: "Acme",
  registrationNumber: "RC123456",
  country: "NG",
  address: {
    line1: "1 Marina Road",
    city: "Lagos",
    region: "Lagos",
    postalCode: "101001",
    country: "NG",
  },
  contacts: [
    { role: "primary", name: "Ada Obi", email: "ada@acme.example" },
    {
      role: "compliance",
      name: "Tunde Bello",
      email: "compliance@acme.example",
      phone: "+2348000000000",
    },
  ],
};

const stub = (id: string): OnboardingExporter => ({
  id,
  receiver: id,
  export: (p) => ok({ name: p.legalName }),
});

describe("createExporterRegistry", () => {
  it("registers an exporter and looks it up by id", () => {
    const registry = createExporterRegistry();
    const exporter = stub("receiver-a");
    expect(registry.register(exporter).ok).toBe(true);
    expect(registry.get("receiver-a")).toBe(exporter);
    expect(registry.ids()).toEqual(["receiver-a"]);
  });

  it("returns undefined for an unregistered id", () => {
    expect(createExporterRegistry().get("nobody")).toBeUndefined();
  });

  it("rejects a duplicate id and keeps the first exporter", () => {
    const registry = createExporterRegistry();
    const first = stub("receiver-a");
    registry.register(first);
    const second = registry.register(stub("receiver-a"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("EXPORTER_DUPLICATE");
    expect(registry.get("receiver-a")).toBe(first);
  });

  it("rejects a malformed id", () => {
    const result = createExporterRegistry().register(stub("Receiver A"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXPORTER_INVALID");
  });

  it("exports through the registered exporter", () => {
    const registry = createExporterRegistry();
    registry.register(stub("receiver-a"));
    expect(registry.export("receiver-a", profile)).toEqual(
      ok({ name: "Acme Trading Limited" }),
    );
  });

  it("fails to export for an unknown id", () => {
    const result = createExporterRegistry().export("nobody", profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXPORTER_UNKNOWN");
  });
});

describe("examples/onboarding/example-receiver-exporter.ts", () => {
  it("maps the profile onto the receiver's form fields", () => {
    const registry = createExporterRegistry();
    registry.register(exampleReceiverExporter);
    expect(registry.export("example-receiver", profile)).toEqual(
      ok({
        company_name: "Acme Trading Limited",
        trading_as: "Acme",
        registration_no: "RC123456",
        country_of_incorporation: "NG",
        registered_address: "1 Marina Road, Lagos, Lagos, 101001",
        address_country: "NG",
        contact_name: "Tunde Bello",
        contact_email: "compliance@acme.example",
        contact_phone: "+2348000000000",
      }),
    );
  });

  it("falls back to the primary contact and omits optional fields", () => {
    const result = exampleReceiverExporter.export({
      ...profile,
      tradingName: undefined,
      contacts: [{ role: "primary", name: "Ada Obi", email: "ada@acme.example" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contact_name).toBe("Ada Obi");
    expect(result.value).not.toHaveProperty("trading_as");
    expect(result.value).not.toHaveProperty("contact_phone");
  });

  it.each([
    ["company_name", { legalName: " " }],
    ["registration_no", { registrationNumber: "" }],
    ["registered_address", { address: { ...profile.address, line1: "" } }],
    ["registered_address", { address: { ...profile.address, city: " " } }],
    ["address_country", { address: { ...profile.address, country: "" } }],
    [
      "contact_email",
      { contacts: [{ role: "compliance" as const, name: "Tunde Bello", email: "" }] },
    ],
  ])("fails with PROFILE_INCOMPLETE when %s is blank", (field, patch) => {
    const result = exampleReceiverExporter.export({ ...profile, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROFILE_INCOMPLETE");
      expect(result.error.message).toContain(field);
    }
  });

  it("fails with PROFILE_INCOMPLETE when no usable contact exists", () => {
    const result = exampleReceiverExporter.export({
      ...profile,
      contacts: [{ role: "finance", name: "Kemi", email: "finance@acme.example" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROFILE_INCOMPLETE");
  });
});
