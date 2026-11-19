import { describe, expect, it } from "vitest";
import {
  getReceiverFieldsForCorridor,
  validateReceiverFields,
  ANCHOR_RECEIVER_SCHEMAS,
} from "../web/lib/send";

describe("Recipient details form driven by anchor requirements (Issue #688)", () => {
  it("does not use a single hardcoded field list; fields differ across routes", () => {
    const usFields = getReceiverFieldsForCorridor("reference-testnet");
    const ngFields = getReceiverFieldsForCorridor("ng-cowrie");
    const mxFields = getReceiverFieldsForCorridor("mx-example");
    const zaFields = getReceiverFieldsForCorridor("zeam");

    // US requires ACH routing number
    expect(usFields.some((f) => f.name === "routing_number")).toBe(true);
    expect(ngFields.some((f) => f.name === "routing_number")).toBe(false);

    // Nigeria requires NUBAN account number and bank code
    expect(ngFields.some((f) => f.name === "bank_code")).toBe(true);
    expect(usFields.some((f) => f.name === "bank_code")).toBe(false);

    // Mexico requires CLABE
    expect(mxFields.some((f) => f.name === "clabe")).toBe(true);
    expect(ngFields.some((f) => f.name === "clabe")).toBe(false);

    // South Africa requires branch code
    expect(zaFields.some((f) => f.name === "branch_code")).toBe(true);
    expect(mxFields.some((f) => f.name === "branch_code")).toBe(false);
  });

  it("changing the route returns different fields", () => {
    const routeA = "ng-cowrie";
    const routeB = "mx-example";

    const fieldsA = getReceiverFieldsForCorridor(routeA);
    const fieldsB = getReceiverFieldsForCorridor(routeB);

    const namesA = fieldsA.map((f) => f.name);
    const namesB = fieldsB.map((f) => f.name);

    expect(namesA).not.toEqual(namesB);
  });

  it("validates required non-optional fields strictly", () => {
    const ngFields = ANCHOR_RECEIVER_SCHEMAS["ng-cowrie"];

    // Missing all fields
    const resEmpty = validateReceiverFields(ngFields, {});
    expect(resEmpty.valid).toBe(false);
    expect(resEmpty.errors.account_number).toContain("required");
    expect(resEmpty.errors.bank_code).toContain("required");
    expect(resEmpty.errors.account_name).toContain("required");
    // BVN is optional so it should NOT have an error
    expect(resEmpty.errors.bvn).toBeUndefined();

    // Partial fill
    const resPartial = validateReceiverFields(ngFields, {
      account_number: "0123456789",
    });
    expect(resPartial.valid).toBe(false);
    expect(resPartial.errors.account_number).toBeUndefined();
    expect(resPartial.errors.bank_code).toContain("required");

    // Valid complete fill
    const resComplete = validateReceiverFields(ngFields, {
      account_number: "0123456789",
      bank_code: "058 (GTBank)",
      account_name: "Amina Adeleke",
    });
    expect(resComplete.valid).toBe(true);
    expect(Object.keys(resComplete.errors).length).toBe(0);
  });
});
