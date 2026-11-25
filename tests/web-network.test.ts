import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import deployments from "../contracts/deployments.json";
import {
  NETWORKS,
  NETWORK_LABEL,
  isNetworkId,
  networkSearch,
  parseNetwork,
} from "../web/lib/network";
import { fetchAttestations, registryId } from "../web/lib/registry";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web network switch", () => {
  it("offers testnet and mainnet, and calls Stellar's `public` Mainnet", () => {
    expect(NETWORKS).toEqual(["testnet", "public"]);
    expect(NETWORK_LABEL).toEqual({ testnet: "Testnet", public: "Mainnet" });
    // Every network the switch offers is one deployments.json has an entry for.
    for (const network of NETWORKS) expect(deployments).toHaveProperty(network);
  });

  it("reads a network from a link, taking `mainnet` to mean public", () => {
    expect(parseNetwork("testnet")).toBe("testnet");
    expect(parseNetwork("public")).toBe("public");
    expect(parseNetwork("mainnet")).toBe("public");
    expect(parseNetwork("  Mainnet ")).toBe("public");
    expect(parseNetwork("PUBLIC")).toBe("public");
  });

  it("names no network for anything else, rather than guessing one", () => {
    for (const other of [undefined, null, "", "futurenet", "main", "test", "public;", "0"]) {
      expect(parseNetwork(other), String(other)).toBeUndefined();
      expect(isNetworkId(other), String(other)).toBe(false);
    }
    // An inherited property name is not a network either.
    expect(parseNetwork("toString")).toBeUndefined();
  });

  it("puts the choice in the URL, and leaves the default network's URL bare", () => {
    expect(networkSearch("", "public", "testnet")).toBe("?network=public");
    expect(networkSearch("?network=public", "testnet", "testnet")).toBe("");
    // Whatever else is in the query stays.
    expect(networkSearch("?corridor=ng-cowrie", "public", "testnet")).toBe(
      "?corridor=ng-cowrie&network=public",
    );
    expect(networkSearch("?corridor=ng-cowrie&network=public", "testnet", "testnet")).toBe(
      "?corridor=ng-cowrie",
    );
    // A deployment whose default is mainnet names testnet instead.
    expect(networkSearch("", "testnet", "public")).toBe("?network=testnet");
    expect(networkSearch("?network=testnet", "public", "public")).toBe("");
  });
});

describe("web registry, by network", () => {
  it("knows the registry of a network that has one, and that mainnet has none yet", () => {
    expect(registryId("testnet")).toBe(deployments.testnet.registry);
    expect(registryId("public")).toBeUndefined();
    expect(registryId("futurenet")).toBeUndefined();
  });

  it("answers `not deployed` for a network with no registry, without calling anything", async () => {
    // Refuses instead of passing through, so a wrong answer cannot reach a real RPC either.
    const fetched = vi.fn(async () => {
      throw new Error("this test must not reach the network");
    });
    vi.stubGlobal("fetch", fetched);
    const snapshot = await fetchAttestations("public");
    // Not a failed read and not an empty registry: a third answer, which the page shows as
    // its own empty state.
    expect(snapshot).toMatchObject({
      ok: false,
      deployed: false,
      anchors: [],
      error: "no registry deployed on public",
    });
    expect(Number.isNaN(Date.parse(snapshot.readAt))).toBe(false);
    expect(snapshot.latestLedger).toBeUndefined();
    expect(fetched).not.toHaveBeenCalled();
  });

  it("points the empty state at a deployment plan that is in the repository", () => {
    const repo = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
    const source = readFileSync(repo("web/components/NoRegistry.tsx"), "utf8");
    const linked =
      /corridor-in-a-box\/blob\/main\/(docs\/[\w./-]+\.md)/.exec(source)?.[1] ?? "";
    expect(linked).toBe("docs/mainnet-registry.md");
    expect(existsSync(repo(linked))).toBe(true);
    // The empty state promises "entry criteria"; the plan has to still have them.
    expect(readFileSync(repo(linked), "utf8")).toMatch(/^## 1\. Entry Criteria\r?$/m);
  });
});
