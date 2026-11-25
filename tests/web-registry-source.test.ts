import {
  Address,
  nativeToScVal,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAttestations, registryId, REGISTRY_NETWORK } from "../web/lib/registry";

// Both networks are given a registry here, which contracts/deployments.json does not do yet
// (mainnet's is null), so that "which registry did this read go to" has two answers to tell
// apart. Nothing below is deployed anywhere: the ids are 32 bytes of 0x01 and of 0x02, the
// RPC hosts are on the reserved `.example` domain, and `fetch` is replaced for every test.
const fake = vi.hoisted(() => ({
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://rpc.testnet.example",
    registry: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
  },
  public: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://rpc.mainnet.example",
    registry: "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
  },
}));

vi.mock("../contracts/deployments.json", () => ({ default: fake }));

const ATTESTER = "GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC";

/** The one anchor each fake registry holds, and the ledger its RPC reports. */
const HELD: Record<string, { domain: string; ledger: number }> = {
  [fake.testnet.rpcUrl]: { domain: "testnet-only.example", ledger: 100 },
  [fake.public.rpcUrl]: { domain: "mainnet-only.example", ledger: 900 },
};

const u32 = (n: number) => nativeToScVal(n, { type: "u32" });

/** A contract struct as the registry returns it: a map keyed by symbols, in key order. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] })),
  );
}

/** What the registry contract answers for one read method. */
function answer(method: string, domain: string): xdr.ScVal {
  switch (method) {
    case "domains":
      return xdr.ScVal.scvVec([nativeToScVal(domain, { type: "string" })]);
    case "get_anchor":
      return struct({
        domain: nativeToScVal(domain, { type: "string" }),
        seps: u32(0b0100001), // SEP-1 and SEP-31
        toml_hash: xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
        probes_run: u32(0b0010001), // toml_fetch and sep31_info
        probes_passed: u32(0b0000001), // toml_fetch
        attested_ledger: u32(77),
        attester: new Address(ATTESTER).toScVal(),
      });
    case "serves_sep31":
      return xdr.ScVal.scvBool(true);
    case "staleness":
      return u32(12);
    default:
      throw new Error(`the fake registry has no method ${method}`);
  }
}

/**
 * A `getLatestLedger` reply for an empty ledger. The SDK decodes the header and the close
 * meta before it hands back the sequence, so both have to be real XDR.
 */
function latestLedger(sequence: number) {
  const zero = Buffer.alloc(32);
  const header = new xdr.LedgerHeader({
    ledgerVersion: 23,
    previousLedgerHash: zero,
    scpValue: new xdr.StellarValue({
      txSetHash: zero,
      closeTime: 1n,
      upgrades: [],
      ext: xdr.StellarValueExt.stellarValueBasic(),
    }),
    txSetResultHash: zero,
    bucketListHash: zero,
    ledgerSeq: sequence,
    totalCoins: 0n,
    feePool: 0n,
    inflationSeq: 0,
    idPool: 0n,
    baseFee: 100,
    baseReserve: 5_000_000,
    maxTxSetSize: 100,
    skipList: [zero, zero, zero, zero],
    ext: xdr.LedgerHeaderExt.v0(),
  });
  const meta = xdr.LedgerCloseMeta.v0(
    new xdr.LedgerCloseMetaV0({
      ledgerHeader: new xdr.LedgerHeaderHistoryEntry({
        hash: zero,
        header,
        ext: xdr.LedgerHeaderHistoryEntryExt.v0(),
      }),
      txSet: new xdr.TransactionSet({ previousLedgerHash: zero, txs: [] }),
      txProcessing: [],
      upgradesProcessing: [],
      scpInfo: [],
    }),
  );
  return {
    id: "00".repeat(32),
    protocolVersion: 23,
    sequence,
    closeTime: "1",
    headerXdr: header.toXDR("base64"),
    metadataXdr: meta.toXDR("base64"),
  };
}

interface Call {
  /** The RPC origin the request went to. */
  rpc: string;
  /** The contract a simulated call was addressed to; absent for `getLatestLedger`. */
  contract?: string;
  method: string;
}

/**
 * A Soroban RPC for both fake networks. It records where each request went and which
 * contract it called, which is what these tests are about. `down` names an RPC origin that
 * refuses every request.
 */
function fakeRpc(down?: string) {
  const calls: Call[] = [];
  const fetchImpl = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const request = new Request(...args);
    const rpc = new URL(request.url).origin;
    const held = HELD[rpc];
    if (!held) throw new Error(`unexpected RPC host ${rpc}`);
    if (rpc === down) throw new TypeError("fetch failed");

    const body = (await request.json()) as {
      id: number;
      method: string;
      params?: { transaction?: string };
    };
    let result: unknown;
    if (body.method === "getLatestLedger") {
      calls.push({ rpc, method: body.method });
      result = latestLedger(held.ledger);
    } else if (body.method === "simulateTransaction") {
      // The passphrase only matters for hashing, and nothing here is signed or hashed.
      const envelope = body.params?.transaction ?? "";
      const op = TransactionBuilder.fromXDR(envelope, fake.testnet.networkPassphrase)
        .operations[0];
      if (
        op?.type !== "invokeHostFunction" ||
        op.func.type !== "hostFunctionTypeInvokeContract"
      ) {
        throw new Error(`unexpected operation ${op?.type}`);
      }
      const invoked = op.func.invokeContract;
      const method = invoked.functionName.toString();
      calls.push({
        rpc,
        contract: Address.fromScAddress(invoked.contractAddress).toString(),
        method,
      });
      result = {
        latestLedger: held.ledger,
        minResourceFee: "0",
        results: [{ auth: [], xdr: answer(method, held.domain).toXDR("base64") }],
        transactionData: new SorobanDataBuilder().build().toXDR("base64"),
      };
    } else {
      throw new Error(`unexpected RPC method ${body.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fetchImpl);
  return calls;
}

const sources = (calls: Call[]) => ({
  rpcs: [...new Set(calls.map((c) => c.rpc))],
  contracts: [...new Set(calls.flatMap((c) => c.contract ?? []))],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web registry source, once both networks have a registry", () => {
  it("reads testnet's registry over testnet's RPC", async () => {
    const calls = fakeRpc();
    const snapshot = await fetchAttestations("testnet");

    expect(snapshot).toMatchObject({ ok: true, deployed: true, latestLedger: 100 });
    expect(snapshot.anchors.map((a) => a.domain)).toEqual(["testnet-only.example"]);
    expect(sources(calls)).toEqual({
      rpcs: [fake.testnet.rpcUrl],
      contracts: [fake.testnet.registry],
    });
  });

  it("reads mainnet's registry over mainnet's RPC, never testnet's", async () => {
    const calls = fakeRpc();
    const snapshot = await fetchAttestations("public");

    expect(snapshot).toMatchObject({ ok: true, deployed: true, latestLedger: 900 });
    expect(snapshot.anchors).toEqual([
      {
        domain: "mainnet-only.example",
        seps: [1, 31],
        probesRun: ["toml_fetch", "sep31_info"],
        probesPassed: ["toml_fetch"],
        tomlHash: "07".repeat(32),
        attestedLedger: 77,
        attester: ATTESTER,
        staleness: 12,
        servesSep31: true,
      },
    ]);
    expect(sources(calls)).toEqual({
      rpcs: [fake.public.rpcUrl],
      contracts: [fake.public.registry],
    });
    // One ledger read, the domain list, then three reads for the one anchor.
    expect(calls.map((c) => c.method).sort()).toEqual([
      "domains",
      "getLatestLedger",
      "get_anchor",
      "serves_sep31",
      "staleness",
    ]);
  });

  it("reads the default network when it is not told which", async () => {
    fakeRpc();
    const snapshot = await fetchAttestations();
    const expected = REGISTRY_NETWORK === "public" ? "mainnet-only" : "testnet-only";
    expect(snapshot.anchors.map((a) => a.domain)).toEqual([`${expected}.example`]);
  });

  it("gives each network its own registry id", () => {
    expect(registryId("testnet")).toBe(fake.testnet.registry);
    expect(registryId("public")).toBe(fake.public.registry);
  });

  it("keeps one network's outage out of the other network's answer", async () => {
    fakeRpc(fake.public.rpcUrl);
    // The dashboard reads both at once, exactly like this.
    const [testnet, mainnet] = await Promise.all([
      fetchAttestations("testnet"),
      fetchAttestations("public"),
    ]);

    expect(testnet.ok).toBe(true);
    expect(testnet.anchors.map((a) => a.domain)).toEqual(["testnet-only.example"]);
    // Mainnet has a registry that could not be read: not "no registry", and not "empty".
    expect(mainnet).toMatchObject({ ok: false, deployed: true, anchors: [] });
    expect(mainnet.error).toBeTruthy();
    expect(mainnet.latestLedger).toBeUndefined();
  });
});
