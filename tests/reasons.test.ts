import { describe, expect, it } from "vitest";
import {
  appendOptionReason,
  formatOptionReason,
  summarizeOptionReasons,
} from "@corridor/router";

describe("router option reasons", () => {
  it("formats offered and dropped reasons concisely", () => {
    expect(formatOptionReason({ kind: "locked", ttlSeconds: 60 })).toBe("locked for 60 s");
    expect(formatOptionReason({ kind: "amount-above-max", max: 5000 })).toBe(
      "dropped: amount above max 5,000",
    );
    expect(
      formatOptionReason({
        kind: "missing-fields",
        fields: ["bankCode", "accountNumber"],
      }),
    ).toBe("dropped: missing required fields: bankCode, accountNumber");
  });

  it("accumulates plain-language reasons across planner steps in a fixed scenario snapshot", () => {
    const firmAnchor = appendOptionReason(
      appendOptionReason(
        { receivingDomain: "cowrie.example", status: "offered" as const },
        { kind: "custom", detail: "lane confirmed open" },
      ),
      { kind: "locked", ttlSeconds: 60 },
    );

    const indicativeAnchor = appendOptionReason(
      appendOptionReason(
        { receivingDomain: "mykobo.example", status: "offered" as const },
        { kind: "custom", detail: "lane confirmed open" },
      ),
      { kind: "indicative", source: "sep31-info" },
    );

    const overLimitAnchor = appendOptionReason(
      { receivingDomain: "zeam.example", status: "dropped" as const },
      { kind: "amount-above-max", max: 5000, asset: "USDC" },
    );

    const timedOutAnchor = appendOptionReason(
      { receivingDomain: "slow.example", status: "dropped" as const },
      { kind: "pricing-timeout", timeoutSeconds: 5 },
    );

    const breakerOpenAnchor = appendOptionReason(
      { receivingDomain: "unhealthy.example", status: "dropped" as const },
      { kind: "breaker-open", retryAfterSeconds: 30 },
    );

    const disallowedEstimated = appendOptionReason(
      appendOptionReason(
        { receivingDomain: "history-only.example", status: "dropped" as const },
        { kind: "estimated", sampleCount: 1912, windowDays: 7 },
      ),
      {
        kind: "label-disallowed",
        label: "estimated",
        allowedLabels: ["locked", "indicative"],
      },
    );

    const summary = summarizeOptionReasons([
      firmAnchor,
      indicativeAnchor,
      overLimitAnchor,
      timedOutAnchor,
      breakerOpenAnchor,
      disallowedEstimated,
    ]);

    expect(summary).toMatchInlineSnapshot(`
      [
        {
          "reasons": [
            "lane confirmed open",
            "locked for 60 s",
          ],
          "receivingDomain": "cowrie.example",
          "status": "offered",
        },
        {
          "reasons": [
            "lane confirmed open",
            "indicative rate from sep31-info",
          ],
          "receivingDomain": "mykobo.example",
          "status": "offered",
        },
        {
          "reasons": [
            "dropped: amount above max 5,000 USDC",
          ],
          "receivingDomain": "zeam.example",
          "status": "dropped",
        },
        {
          "reasons": [
            "dropped: no price within 5 s",
          ],
          "receivingDomain": "slow.example",
          "status": "dropped",
        },
        {
          "reasons": [
            "dropped: circuit breaker open (retry in 30 s)",
          ],
          "receivingDomain": "unhealthy.example",
          "status": "dropped",
        },
        {
          "reasons": [
            "estimated from 1,912 samples over 7 d",
            "dropped: label estimated excluded by policy (allowed: locked, indicative)",
          ],
          "receivingDomain": "history-only.example",
          "status": "dropped",
        },
      ]
    `);
  });
});
