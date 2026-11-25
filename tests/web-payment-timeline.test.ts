import { describe, expect, it } from "vitest";
import { ALL_STATES } from "@corridor/engine";
import {
  OUTCOME_TEXT,
  TIMELINE_STEPS,
  advance,
  isFinalState,
  outcomeOf,
  timelineSteps,
} from "../web/lib/payment-timeline";
import { isTxHash, txUrl } from "../web/lib/explorer";
import generatedStates from "../web/lib/generated/states.json";

const statuses = (progress: number, state: string) =>
  timelineSteps(progress, state).map((s) => s.status);

describe("advance", () => {
  it("places each forward state on the five steps", () => {
    expect(advance(0, { state: "created" })).toBe(0);
    expect(advance(0, { state: "quoted" })).toBe(1);
    expect(advance(0, { state: "compliant" })).toBe(2);
    for (const s of ["opened", "funding", "funded", "verifying", "settling", "retrying"]) {
      expect(advance(0, { state: s })).toBe(3);
    }
    expect(advance(0, { state: "settled" })).toBe(4);
    expect(advance(0, { state: "reconciled" })).toBe(4);
    expect(advance(0, { state: "completed" })).toBe(5);
  });

  it("keeps earlier progress through off-path and terminal states", () => {
    for (const s of ["recovering", "refund_pending", "refunded", "held", "failed"]) {
      expect(advance(2, { state: s })).toBe(2);
    }
  });

  it("never moves backwards", () => {
    expect(advance(4, { state: "quoted" })).toBe(4);
  });

  it("counts a settlement hash as reaching settled even if no poll saw it", () => {
    expect(advance(1, { state: "refunded", stellarTxHash: "ab".repeat(32) })).toBe(4);
  });

  it("knows a position or an outcome for every engine state", () => {
    for (const s of ALL_STATES) {
      const placed = advance(0, { state: s }) > 0 || s === "created";
      expect(placed || outcomeOf(s) !== "in_progress").toBe(true);
    }
  });
});

describe("timelineSteps", () => {
  it("marks the step in flight as active", () => {
    expect(statuses(0, "created")).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(statuses(3, "settling")).toEqual(["done", "done", "done", "active", "pending"]);
  });

  it("completes every step", () => {
    expect(statuses(5, "completed")).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("shows where a failed or refunded payment stopped", () => {
    expect(statuses(2, "failed")).toEqual(["done", "done", "stopped", "pending", "pending"]);
    expect(statuses(4, "refunded")).toEqual(["done", "done", "done", "done", "stopped"]);
  });

  it("names the five steps in order", () => {
    expect(TIMELINE_STEPS).toEqual(["quoted", "compliant", "opened", "settled", "completed"]);
  });
});

describe("outcomeOf", () => {
  it("tells failed, refunded and held apart from progress", () => {
    expect(outcomeOf("settling")).toBe("in_progress");
    expect(outcomeOf("completed")).toBe("completed");
    expect(outcomeOf("failed")).toBe("failed");
    expect(outcomeOf("refunded")).toBe("refunded");
    expect(outcomeOf("refund_pending")).toBe("refund_pending");
    expect(outcomeOf("held")).toBe("held");
    expect(OUTCOME_TEXT.refunded).not.toBe(OUTCOME_TEXT.failed);
  });

  it("stops polling exactly on the engine's terminal states", () => {
    expect(ALL_STATES.filter(isFinalState)).toEqual(generatedStates.terminal);
  });
});

describe("settlement explorer link", () => {
  const hash = "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889";

  it("links a transaction on testnet", () => {
    expect(txUrl("testnet", hash)).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
  });

  it("only treats 64-hex strings as Stellar transaction hashes", () => {
    expect(isTxHash(hash)).toBe(true);
    expect(isTxHash("mocktx0001")).toBe(false);
  });
});
