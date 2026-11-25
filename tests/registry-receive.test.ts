// Reading the receive list and its bounds back.
//
// Two things can go wrong quietly here. A bound nobody recorded can come back as
// zero, which reads as "this anchor takes any amount"; and a registry that has
// no receive list for a domain can be reported the same way as one that could
// not be read. The tests below keep both apart.

import { describe, expect, it, vi } from "vitest";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  AnchorRegistry,
  RegistryContractError,
  type AnchorReceiveList,
} from "@corridor/registry";

type RegistryRead = (method: string, ...args: xdr.ScVal[]) => Promise<unknown>;

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ATTESTER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function newRegistry(): AnchorRegistry {
  return new AnchorRegistry({
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: CONTRACT,
    networkPassphrase: "Test SDF Network ; September 2015",
  });
}

function stubRead(registry: AnchorRegistry) {
  return vi.spyOn(registry as unknown as { read: RegistryRead }, "read");
}

/** What `get_receive` decodes to: an i128 is a bigint, `None` is null. */
const RAW_LIST = {
  domain: "a.example",
  assets: [
    { code: "NGN", max_amount: 50_000_000_000_000n, min_amount: 10_000_000_000n },
    { code: "USDC", max_amount: null, min_amount: 1_000_000n },
    { code: "KES", max_amount: null, min_amount: null },
  ],
  attested_ledger: 150,
  attester: ATTESTER,
};

/** The error a simulated read throws when the contract reverts with `code`. */
function reverted(method: string, code: number): Error {
  return new Error(`${method} failed: HostError: Error(Contract, #${code})`);
}

/** What a read throws when the deployed registry has no such method at all. */
function noSuchMethod(method: string): Error {
  return new Error(`${method} failed: HostError: Error(WasmVm, MissingValue)`);
}

/**
 * The receive list the attester client sends, as asserted in
 * tests/attester-receive.test.ts and decoded by the contract's own test.
 */
const GOLDEN_RECEIVE_LIST =
  "AAAAEAAAAAEAAAADAAAAEQAAAAEAAAADAAAADwAAAARjb2RlAAAADgAAAANOR04AAAAADwAAAAptYXhf" +
  "YW1vdW50AAAAAAAKAAAAAAAAAAAAAC15iD0gAAAAAA8AAAAKbWluX2Ftb3VudAAAAAAACgAAAAAAAAAA" +
  "AAAAAlQL5AAAAAARAAAAAQAAAAMAAAAPAAAABGNvZGUAAAAOAAAABFVTREMAAAAPAAAACm1heF9hbW91" +
  "bnQAAAAAAAEAAAAPAAAACm1pbl9hbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAD0JAAAAAEQAAAAEAAAAD" +
  "AAAADwAAAARjb2RlAAAADgAAAANLRVMAAAAADwAAAAptYXhfYW1vdW50AAAAAAABAAAADwAAAAptaW5f" +
  "YW1vdW50AAAAAAAB";

describe("AnchorRegistry.getReceive", () => {
  it("decodes the list, with amounts back in decimal", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockResolvedValue(RAW_LIST);

    const list = await registry.getReceive("a.example");

    expect(list).toStrictEqual<AnchorReceiveList>({
      domain: "a.example",
      assets: [
        { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
        { code: "USDC", minAmount: "0.1" },
        { code: "KES" },
      ],
      attestedLedger: 150,
      attester: ATTESTER,
    });
    expect(read).toHaveBeenCalledWith("get_receive", expect.anything());
    expect(scValToNative(read.mock.calls[0][1])).toBe("a.example");
  });

  it("leaves an unrecorded bound out, where a zero would be a claim", async () => {
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue(RAW_LIST);

    const list = await registry.getReceive("a.example");

    // No key at all: JSON and Object.keys would treat `minAmount: undefined` or
    // a "0" as something that was said.
    expect(Object.keys(list!.assets[2])).toEqual(["code"]);
    expect(Object.keys(list!.assets[1]).sort()).toEqual(["code", "minAmount"]);
  });

  it("keeps a stated zero as zero", async () => {
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue({
      ...RAW_LIST,
      assets: [{ code: "NGN", max_amount: null, min_amount: 0n }],
    });

    const list = await registry.getReceive("a.example");

    expect(list!.assets).toStrictEqual([{ code: "NGN", minAmount: "0" }]);
  });

  it("converts at ten to the seventh with no float in the way", async () => {
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue({
      ...RAW_LIST,
      assets: [
        { code: "A", max_amount: 10_000_000n, min_amount: 1n },
        { code: "B", max_amount: (1n << 127n) - 1n, min_amount: 3_000_000n },
      ],
    });

    const list = await registry.getReceive("a.example");

    expect(list!.assets).toStrictEqual([
      { code: "A", minAmount: "0.0000001", maxAmount: "1" },
      { code: "B", minAmount: "0.3", maxAmount: "17014118346046923173168730371588.4105727" },
    ]);
  });

  it("reads back the bytes the attester client sends", async () => {
    // From real XDR this time, not from a hand-written object: this is what
    // scValToNative hands the reader for the struct the contract stores.
    const assets = scValToNative(xdr.ScVal.fromXDR(GOLDEN_RECEIVE_LIST, "base64"));
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue({ ...RAW_LIST, assets });

    const list = await registry.getReceive("a.example");

    expect(list!.assets).toStrictEqual([
      { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
      { code: "USDC", minAmount: "0.1" },
      { code: "KES" },
    ]);
  });

  it("is null when the registry holds no receive list for the domain", async () => {
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(
      reverted("registry.get_receive", RegistryContractError.NotFound),
    );

    await expect(registry.getReceive("a.example")).resolves.toBeNull();
  });

  it("is null when the deployed registry predates receive lists", async () => {
    // Such a contract has no get_receive, so for every domain in it "holds none"
    // is the true answer, and a reader should not have to catch to learn it.
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(noSuchMethod("registry.get_receive"));

    await expect(registry.getReceive("a.example")).resolves.toBeNull();
  });

  it("rethrows everything else, so an outage is not read as an absence", async () => {
    for (const failure of [
      reverted("registry.get_receive", RegistryContractError.NotInitialised),
      new Error("registry.get_receive failed: HostError: Error(Budget, ExceededLimit)"),
      new Error("registry.get_receive failed: HostError: Error(WasmVm, InvalidAction)"),
      new Error("fetch failed"),
    ]) {
      const registry = newRegistry();
      stubRead(registry).mockRejectedValue(failure);

      await expect(registry.getReceive("a.example"), failure.message).rejects.toThrow(
        failure.message,
      );
    }
  });
});

describe("AnchorRegistry.receiveLimits", () => {
  it("asks the contract for one code and decodes its entry", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockResolvedValue(RAW_LIST.assets[0]);

    await expect(registry.receiveLimits("a.example", "NGN")).resolves.toStrictEqual({
      code: "NGN",
      minAmount: "1000",
      maxAmount: "5000000",
    });

    expect(read).toHaveBeenCalledWith("receive_limits", expect.anything(), expect.anything());
    const [, domain, code] = read.mock.calls[0];
    expect(scValToNative(domain)).toBe("a.example");
    expect(scValToNative(code)).toBe("NGN");
  });

  it("is null when the list does not hold the code", async () => {
    // The contract's `None`, which decodes to null.
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue(null);

    await expect(registry.receiveLimits("a.example", "USDC")).resolves.toBeNull();
  });

  it("returns a listed asset that has no bounds as an entry, not as null", async () => {
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue(RAW_LIST.assets[2]);

    await expect(registry.receiveLimits("a.example", "KES")).resolves.toStrictEqual({
      code: "KES",
    });
  });

  it("surfaces NotFound when no list was ever recorded for the domain", async () => {
    // A different answer from null: nobody looked, versus it does not take this.
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(
      reverted("registry.receive_limits", RegistryContractError.NotFound),
    );

    await expect(registry.receiveLimits("a.example", "NGN")).rejects.toThrow("#6");
  });
});

describe("RegistryContractError", () => {
  it("numbers the receive-list error the way the contract does", () => {
    // Pinned on the Rust side too, in the attester crate's
    // `the_new_error_numbers_are_the_ones_the_clients_branch_on`.
    expect(RegistryContractError.InvalidAmount).toBe(11);
    expect(RegistryContractError.InvalidCountry).toBe(10);
  });
});
