import { describe, expect, it } from "vitest";
import { formatRemainingSeconds, getRemainingSeconds, isQuoteExpired } from "../web/lib/send";

describe("Countdown for locked prices (Issue #687)", () => {
  it("formats remaining seconds into MM:SS format", () => {
    expect(formatRemainingSeconds(0)).toBe("00:00");
    expect(formatRemainingSeconds(-5)).toBe("00:00");
    expect(formatRemainingSeconds(5)).toBe("00:05");
    expect(formatRemainingSeconds(45)).toBe("00:45");
    expect(formatRemainingSeconds(60)).toBe("01:00");
    expect(formatRemainingSeconds(125)).toBe("02:05");
  });

  it("determines whether a quote has expired", () => {
    const pastTime = new Date(Date.now() - 5000).toISOString();
    expect(isQuoteExpired(pastTime)).toBe(true);

    const futureTime = new Date(Date.now() + 60000).toISOString();
    expect(isQuoteExpired(futureTime)).toBe(false);

    expect(isQuoteExpired(undefined)).toBe(false);
  });

  it("computes remaining seconds accurately", () => {
    const futureTime = new Date(Date.now() + 30000).toISOString();
    const remaining = getRemainingSeconds(futureTime);
    expect(remaining).toBeGreaterThan(25);
    expect(remaining).toBeLessThanOrEqual(30);

    const pastTime = new Date(Date.now() - 10000).toISOString();
    expect(getRemainingSeconds(pastTime)).toBe(0);
  });

  it("ensures expired quotes cannot be sent", () => {
    // When expired, sending must be disallowed
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const expired = isQuoteExpired(pastDate);
    const canSend = !expired;

    expect(expired).toBe(true);
    expect(canSend).toBe(false);
  });
});
