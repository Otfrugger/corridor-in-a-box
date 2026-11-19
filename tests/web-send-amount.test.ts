import { describe, expect, it } from "vitest";
import { validateSendAmount } from "../web/lib/send";

describe("validateSendAmount (Issue #685: Send app amount and destination form)", () => {
  it("accepts valid positive numbers and decimals", () => {
    expect(validateSendAmount("100")).toEqual({ valid: true });
    expect(validateSendAmount("100.50")).toEqual({ valid: true });
    expect(validateSendAmount("0.01")).toEqual({ valid: true });
    expect(validateSendAmount("999999.99")).toEqual({ valid: true });
  });

  it("rejects empty or whitespace amounts with a clear message", () => {
    const resEmpty = validateSendAmount("");
    expect(resEmpty.valid).toBe(false);
    expect(resEmpty.error).toBe("Please enter an amount");

    const resWhitespace = validateSendAmount("   ");
    expect(resWhitespace.valid).toBe(false);
    expect(resWhitespace.error).toBe("Please enter an amount");
  });

  it("rejects zero with a clear message", () => {
    const res = validateSendAmount("0");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Amount must be greater than 0");

    const resZeroDec = validateSendAmount("0.00");
    expect(resZeroDec.valid).toBe(false);
    expect(resZeroDec.error).toBe("Amount must be greater than 0");
  });

  it("rejects negative amounts with a clear message", () => {
    const res = validateSendAmount("-50");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Amount must be a valid positive number");

    const resDec = validateSendAmount("-0.01");
    expect(resDec.valid).toBe(false);
    expect(resDec.error).toBe("Amount must be a valid positive number");
  });

  it("rejects non-numeric characters, letters, and invalid decimals", () => {
    expect(validateSendAmount("abc").valid).toBe(false);
    expect(validateSendAmount("100abc").valid).toBe(false);
    expect(validateSendAmount("$100").valid).toBe(false);
    expect(validateSendAmount("10.0.0").valid).toBe(false);
    expect(validateSendAmount("..").valid).toBe(false);
  });

  it("rejects amounts below minimum limit when specified", () => {
    const res = validateSendAmount("5", { min: 10 });
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Amount is below the minimum limit of 10");
  });

  it("rejects amounts exceeding maximum limit when specified", () => {
    const res = validateSendAmount("5000", { max: 1000 });
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Amount exceeds the maximum limit of 1000");
  });
});
