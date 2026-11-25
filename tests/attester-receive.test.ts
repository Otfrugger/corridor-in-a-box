// What @corridor/attester puts on the wire for the receive list and its bounds.
//
// Like the metadata tests, these pin the encoding rather than the plumbing. The
// contract reads each entry as a struct: a map keyed by field name, an i128 for a
// stated bound, Void for one that was not stated. A bound sent as zero when the
// anchor stated none would be accepted and read back as a fact that is not true.

import { describe, expect, it } from "vitest";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AnchorAttester, AttesterContractError, isMissingMethod } from "@corridor/attester";
import { probeBit, type ProbeResult, type ReceiveAssetLimits } from "@corridor/probe";

const CONTRACT_ID = "CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L";

const SEP31_RAN = probeBit("toml_fetch") | probeBit("sep31_info");

/** NGN with both bounds, USDC with a minimum only, KES with neither. */
const LIMITS: readonly ReceiveAssetLimits[] = [
  { code: "NGN", minAmount: "1000", maxAmount: "5000000" },
  { code: "USDC", minAmount: "0.1" },
  { code: "KES" },
];

function result(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    domain: "a.example",
    seps: 0b1 | 0b100000,
    probesRun: SEP31_RAN,
    probesPassed: SEP31_RAN,
    tomlHash: "00".repeat(32),
    outcomes: [],
    receiveAssets: LIMITS.map((l) => l.code),
    receiveLimits: LIMITS,
    ...overrides,
  };
}

/**
 * An attester whose every call is recorded and then rejected by the simulated
 * contract with `simError`, so the call log shows what would have been sent.
 */
function recording(signer: Keypair, simError: string) {
  const calls: { method: string; args: xdr.ScVal[] }[] = [];
  const real = new Contract(CONTRACT_ID);
  const attester = new AnchorAttester({
    rpcUrl: "https://rpc.invalid",
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer,
  });
  Object.assign(attester, {
    server: {
      getAccount: async () => new Account(signer.publicKey(), "1"),
      simulateTransaction: async () => ({
        id: "1",
        latestLedger: 1,
        error: simError,
        events: [],
      }),
    },
    contract: {
      call: (method: string, ...args: xdr.ScVal[]) => {
        calls.push({ method, args });
        return real.call(method, ...args);
      },
    },
  });
  return { attester, calls };
}

const TOO_SOON = "HostError: Error(Contract, #3)";
/** What the deployed testnet attester answers for a method it does not have. */
const NO_SUCH_METHOD = "HostError: Error(WasmVm, MissingValue)";

/**
 * The receive list above, exactly as the client must encode it. The contract
 * crate decodes this same string in
 * `decodes_the_receive_list_the_typescript_client_sends`, so the two languages
 * are held to one set of bytes. Change it in both places or in neither.
 */
const GOLDEN_RECEIVE_LIST =
  "AAAAEAAAAAEAAAADAAAAEQAAAAEAAAADAAAADwAAAARjb2RlAAAADgAAAANOR04AAAAADwAAAAptYXhf" +
  "YW1vdW50AAAAAAAKAAAAAAAAAAAAAC15iD0gAAAAAA8AAAAKbWluX2Ftb3VudAAAAAAACgAAAAAAAAAA" +
  "AAAAAlQL5AAAAAARAAAAAQAAAAMAAAAPAAAABGNvZGUAAAAOAAAABFVTREMAAAAPAAAACm1heF9hbW91" +
  "bnQAAAAAAAEAAAAPAAAACm1pbl9hbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAD0JAAAAAEQAAAAEAAAAD" +
  "AAAADwAAAARjb2RlAAAADgAAAANLRVMAAAAADwAAAAptYXhfYW1vdW50AAAAAAABAAAADwAAAAptaW5f" +
  "YW1vdW50AAAAAAAB";

describe("AnchorAttester.attestReceive — argument encoding", () => {
  it("submits the signer, the domain and one entry per asset", async () => {
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    await attester.attestReceive(result());

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("attest_receive");
    expect(calls[0].args).toHaveLength(3);
    const [address, domain, assets] = calls[0].args;
    expect(scValToNative(address)).toBe(signer.publicKey());
    expect(scValToNative(domain)).toBe("a.example");
    // Amounts are scaled by 10^7 and absent bounds are null, never zero.
    expect(scValToNative(assets)).toEqual([
      { code: "NGN", max_amount: 50_000_000_000_000n, min_amount: 10_000_000_000n },
      { code: "USDC", max_amount: null, min_amount: 1_000_000n },
      { code: "KES", max_amount: null, min_amount: null },
    ]);
  });

  it("encodes an entry the way the SDK encodes that struct", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    await attester.attestReceive(result());

    // Built a second way: the SDK sorts the keys and applies the types named.
    const struct = (code: string, min: bigint | null, max: bigint | null) =>
      nativeToScVal(
        { code, max_amount: max, min_amount: min },
        {
          type: {
            code: ["symbol", "string"],
            max_amount: ["symbol", max === null ? undefined : "i128"],
            min_amount: ["symbol", min === null ? undefined : "i128"],
          },
        },
      );
    const expected = xdr.ScVal.scvVec([
      struct("NGN", 10_000_000_000n, 50_000_000_000_000n),
      struct("USDC", 1_000_000n, null),
      struct("KES", null, null),
    ]);
    expect(calls[0].args[2].toXDR("base64")).toBe(expected.toXDR("base64"));
  });

  it("sends the bytes the contract's own test decodes", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    await attester.attestReceive(result());

    expect(calls[0].args[2].toXDR("base64")).toBe(GOLDEN_RECEIVE_LIST);
  });

  it("scales a bound by ten to the seventh, exactly", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    await attester.attestReceive(
      result({
        receiveLimits: [
          { code: "A", minAmount: "0.0000001", maxAmount: "1" },
          { code: "B", minAmount: "0", maxAmount: "922337203685.4775807" },
          {
            code: "C",
            minAmount: "0.3",
            maxAmount: "17014118346046923173168730371588.4105727",
          },
        ],
      }),
    );

    expect(scValToNative(calls[0].args[2])).toEqual([
      { code: "A", max_amount: 10_000_000n, min_amount: 1n },
      // A stated minimum of zero is sent as zero. Only an absent one is Void.
      { code: "B", max_amount: 9_223_372_036_854_775_807n, min_amount: 0n },
      // 0.3 is three million, with no float in between; the maximum is i128::MAX.
      { code: "C", max_amount: (1n << 127n) - 1n, min_amount: 3_000_000n },
    ]);
  });

  it("submits an empty observed list as an empty Vec", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    await attester.attestReceive(result({ receiveAssets: [], receiveLimits: [] }));

    expect(calls).toHaveLength(1);
    expect(scValToNative(calls[0].args[2])).toEqual([]);
  });

  it("keeps the list in the order the anchor served it", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    await attester.attestReceive(
      result({ receiveLimits: [{ code: "ZAR" }, { code: "AAA" }, { code: "NGN" }] }),
    );

    const sent = scValToNative(calls[0].args[2]) as { code: string }[];
    expect(sent.map((a) => a.code)).toEqual(["ZAR", "AAA", "NGN"]);
  });
});

describe("AnchorAttester.attestReceive — what it refuses to send", () => {
  it("sends nothing when the probe produced no receive list", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    const out = await attester.attestReceive(result({ receiveLimits: undefined }));

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("MANIFEST_INVALID");
      expect(out.error.message).toContain("no observed receive list");
    }
    expect(calls).toHaveLength(0);
  });

  it("sends nothing when sep31_info never ran, even if a list is attached", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);
    const never = probeBit("toml_fetch");

    const out = await attester.attestReceive(
      result({ probesRun: never, probesPassed: never }),
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain("never ran");
    expect(calls).toHaveLength(0);
  });

  it("refuses a bound that is not an amount instead of repairing it", async () => {
    for (const bad of [
      "-1",
      "1.12345678",
      "abc",
      "1e3",
      "",
      "170141183460469231731687303715884105728",
    ]) {
      const { attester, calls } = recording(Keypair.random(), TOO_SOON);

      const out = await attester.attestReceive(
        result({
          receiveLimits: [
            { code: "NGN", minAmount: "1" },
            { code: "KES", maxAmount: bad },
          ],
        }),
      );

      expect(out.ok, bad).toBe(false);
      if (!out.ok) {
        expect(out.error.code, bad).toBe("AMOUNT_INVALID");
        expect(out.error.message).toContain("KES");
      }
      // Not even the good entry: a list is one observation, sent whole or not.
      expect(calls, bad).toHaveLength(0);
    }
  });

  it("refuses a domain that is not canonical before building anything", async () => {
    const { attester, calls } = recording(Keypair.random(), TOO_SOON);

    const out = await attester.attestReceive(result({ domain: "A.Example" }));

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain("not a canonical home domain");
    expect(calls).toHaveLength(0);
  });
});

describe("AnchorAttester.attestReceive — what the contract answers", () => {
  it("reports a cooldown with the contract's error number", async () => {
    const { attester } = recording(Keypair.random(), TOO_SOON);

    const out = await attester.attestReceive(result());

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.contractError).toBe(AttesterContractError.TooSoon);
      expect(out.error.methodMissing).toBeUndefined();
    }
  });

  it("names a negative bound the contract refused", async () => {
    const { attester } = recording(Keypair.random(), "HostError: Error(Contract, #9)");

    const out = await attester.attestReceive(result());

    expect(AttesterContractError.InvalidAmount).toBe(9);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.contractError).toBe(AttesterContractError.InvalidAmount);
      expect(out.error.message).toContain("a receive bound is negative (contract error #9)");
    }
  });

  it("says so when the deployed contract predates the write", async () => {
    const { attester, calls } = recording(Keypair.random(), NO_SUCH_METHOD);

    const out = await attester.attestReceive(result());

    // Simulated, found missing, and not treated as a bad submission.
    expect(calls).toHaveLength(1);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.methodMissing).toBe(true);
      expect(out.error.code).toBe("CAPABILITY_MISMATCH");
      expect(out.error.contractError).toBeUndefined();
      expect(out.error.retryable).toBe(false);
      expect(out.error.message).toContain("attest_receive is not deployed");
      expect(out.error.message).toContain("upgrade()");
    }
  });

  it("says the same when it is the registry behind the attester that predates it", async () => {
    // An upgraded attester relaying to a registry with no put_receive: the
    // missing method is one call further in, and the answer has the same shape.
    const { attester } = recording(
      Keypair.random(),
      "HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first):\n" +
        '   0: [Diagnostic Event] topics:[error, Error(WasmVm, MissingValue)], data:"trying to invoke non-existent contract function", put_receive',
    );

    const out = await attester.attestReceive(result());

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.methodMissing).toBe(true);
      expect(out.error.message).toContain("or the registry it relays to");
    }
  });

  it("reports a missing method the same way for the older writes", async () => {
    // The check sits in the shared submit path, so it is not special to limits.
    const { attester } = recording(Keypair.random(), NO_SUCH_METHOD);

    const out = await attester.attestMeta(result());

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.methodMissing).toBe(true);
      expect(out.error.message).toContain("attest_meta is not deployed");
    }
  });

  it("does not mistake a contract error or any other host error for a missing method", () => {
    expect(isMissingMethod(NO_SUCH_METHOD)).toBe(true);
    expect(isMissingMethod(TOO_SOON)).toBe(false);
    expect(isMissingMethod("HostError: Error(Contract, #6)")).toBe(false);
    expect(isMissingMethod("HostError: Error(Budget, ExceededLimit)")).toBe(false);
    expect(isMissingMethod("HostError: Error(WasmVm, InvalidAction)")).toBe(false);
    expect(isMissingMethod("")).toBe(false);
  });
});
