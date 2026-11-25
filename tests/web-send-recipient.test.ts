import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fieldLabel,
  mergeReceiverFields,
  receiverFieldsFromSep12,
  receiverFieldsFromSep31Info,
  sendBlockedBy,
  sep12ReceiverTypes,
  splitReceiverValues,
  validateReceiverFields,
} from "../web/lib/send";

// #688: recipient fields come from the receiving anchor, never a list in the app.

// Two anchors' GET /sep31/info responses, shaped as SEP-31 specifies.
const infoA = {
  receive: {
    USDC: {
      enabled: true,
      sep12: { receiver: { types: { "sep31-receiver": { description: "Receiver" } } } },
      fields: {
        transaction: {
          receiver_routing_number: { description: "Routing number of the destination bank" },
          receiver_account_number: { description: "Bank account number of the destination" },
          type: { description: "Type of deposit", choices: ["SEPA", "SWIFT"] },
          note: { description: "Message for the recipient", optional: true },
        },
      },
    },
  },
};
const infoB = {
  receive: {
    USDC: {
      enabled: true,
      fields: {
        transaction: { receiver_phone_number: { description: "Mobile money number" } },
      },
    },
  },
};

describe("fields from the anchor's /sep31/info (#688)", () => {
  it("reads receive.<asset>.fields.transaction, with descriptions, choices and optional", () => {
    const fields = receiverFieldsFromSep31Info(infoA, "USDC");
    expect(fields.map((f) => f.name)).toEqual([
      "receiver_routing_number",
      "receiver_account_number",
      "type",
      "note",
    ]);
    expect(fields[0]).toEqual({
      name: "receiver_routing_number",
      label: "Receiver routing number",
      description: "Routing number of the destination bank",
      optional: false,
      type: "string",
      source: "sep31-transaction",
    });
    expect(fields[2]?.choices).toEqual(["SEPA", "SWIFT"]);
    expect(fields[3]?.optional).toBe(true);
  });

  it("changing the route changes the fields: another anchor's info gives other fields", () => {
    const a = receiverFieldsFromSep31Info(infoA, "USDC").map((f) => f.name);
    const b = receiverFieldsFromSep31Info(infoB, "USDC").map((f) => f.name);
    expect(b).toEqual(["receiver_phone_number"]);
    expect(a).not.toEqual(b);
  });

  it("returns no fields for an asset the anchor does not list, or a malformed response", () => {
    expect(receiverFieldsFromSep31Info(infoA, "EURC")).toEqual([]);
    expect(receiverFieldsFromSep31Info(null, "USDC")).toEqual([]);
    expect(
      receiverFieldsFromSep31Info({ receive: { USDC: { fields: "x" } } }, "USDC"),
    ).toEqual([]);
  });

  it("names the SEP-12 receiver types the anchor uses for the asset", () => {
    expect(sep12ReceiverTypes(infoA, "USDC")).toEqual(["sep31-receiver"]);
    expect(sep12ReceiverTypes(infoB, "USDC")).toEqual([]);
  });
});

describe("fields from SEP-12 GET /customer (#688)", () => {
  const customer = {
    status: "NEEDS_INFO",
    fields: {
      first_name: { type: "string", description: "The customer's first name" },
      birth_date: { type: "date", description: "Date of birth", optional: true },
      photo_id_front: { type: "binary", description: "Image of the front of the ID" },
      id_type: {
        type: "string",
        description: "Document type",
        choices: ["passport", "drivers_license"],
      },
    },
  };

  it("reads each field's type, description, choices and optional flag", () => {
    const fields = receiverFieldsFromSep12(customer);
    expect(fields.map((f) => [f.name, f.type, f.optional, f.source])).toEqual([
      ["first_name", "string", false, "sep12"],
      ["birth_date", "date", true, "sep12"],
      ["photo_id_front", "binary", false, "sep12"],
      ["id_type", "string", false, "sep12"],
    ]);
    expect(fields[3]?.choices).toEqual(["passport", "drivers_license"]);
  });

  it("merges with the SEP-31 fields, first source winning on a shared name", () => {
    const merged = mergeReceiverFields(
      receiverFieldsFromSep31Info(infoB, "USDC"),
      receiverFieldsFromSep12({
        fields: { receiver_phone_number: { type: "string" }, first_name: {} },
      }),
    );
    expect(merged.map((f) => [f.name, f.source])).toEqual([
      ["receiver_phone_number", "sep31-transaction"],
      ["first_name", "sep12"],
    ]);
  });
});

describe("checking and routing the sender's entries (#688)", () => {
  const fields = mergeReceiverFields(
    receiverFieldsFromSep31Info(infoA, "USDC"),
    receiverFieldsFromSep12({
      fields: { first_name: { type: "string" }, birth_date: { type: "date", optional: true } },
    }),
  );

  it("names each missing required field and skips optional ones", () => {
    const { valid, errors } = validateReceiverFields(fields, {});
    expect(valid).toBe(false);
    expect(Object.keys(errors).sort()).toEqual([
      "first_name",
      "receiver_account_number",
      "receiver_routing_number",
      "type",
    ]);
    expect(errors.receiver_routing_number).toBe("Enter the receiver routing number.");
  });

  it("refuses a value outside the anchor's choices and a malformed date", () => {
    const { errors } = validateReceiverFields(fields, {
      type: "ACH",
      birth_date: "12/31/1990",
    });
    expect(errors.type).toMatch(/listed options/);
    expect(errors.birth_date).toMatch(/must be a date/);
  });

  it("blocks a required document upload, which this app cannot send", () => {
    const docs = receiverFieldsFromSep12({ fields: { photo_id_front: { type: "binary" } } });
    expect(validateReceiverFields(docs, {}).errors.photo_id_front).toMatch(/document upload/);
  });

  it("sends transaction fields with the payment and SEP-12 fields to the anchor's KYC", () => {
    const values = {
      receiver_routing_number: "021000021",
      receiver_account_number: "000123456789",
      type: "SWIFT",
      note: " ",
      first_name: "Adaeze",
    };
    expect(validateReceiverFields(fields, values).valid).toBe(true);
    expect(splitReceiverValues(fields, values)).toEqual({
      destinationFields: {
        receiver_routing_number: "021000021",
        receiver_account_number: "000123456789",
        type: "SWIFT",
      },
      customerFields: { first_name: "Adaeze" },
    });
  });

  it("keeps Send off until the required fields are filled", () => {
    const option = {
      corridorId: "reference-testnet",
      receivingDomain: "anchor.test",
      protocol: "sep31" as const,
      price: { label: "indicative" as const, rate: "1" },
      recipientGets: { asset: "iso4217:USD", amount: "99" },
      fees: { asset: "USDC", amount: "1" },
      reliability: 1,
      reasons: [],
    };
    expect(sendBlockedBy({ option, nowMs: 0, fields, values: {} })).toBe("fields_invalid");
  });

  it("labels fields from their names", () => {
    expect(fieldLabel("receiver_routing_number")).toBe("Receiver routing number");
    expect(fieldLabel("clabe")).toBe("Clabe");
  });
});

describe("no hardcoded field list in the app (#688)", () => {
  it("the recipient form renders only the fields it is given", () => {
    const form = readFileSync(
      resolve(process.cwd(), "web/components/send/RecipientDetailsForm.tsx"),
      "utf8",
    );
    expect(form).toContain("fields.map(");
    expect(form).not.toMatch(/account_number|routing_number|first_name|last_name/);
  });
});
