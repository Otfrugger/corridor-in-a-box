import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const custody = read("docs/custody.md");

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
const anchorOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");

describe("custody statement", () => {
  it("is linked from the README", () => {
    expect(read("README.md")).toContain("(./docs/custody.md)");
  });

  it("links only to pages and headings that exist", () => {
    const links = [...custody.matchAll(/\]\((\.[^)\s]+)\)/g)].map((match) => match[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const [file = "", anchor] = link.split("#");
      const target = resolve(process.cwd(), "docs", file);
      expect(existsSync(target), `${link} points at a file that does not exist`).toBe(true);
      if (anchor === undefined) continue;
      const headings = [...readFileSync(target, "utf8").matchAll(/^#+\s+(.+)$/gm)].map(
        (match) => anchorOf(match[1] ?? ""),
      );
      expect(headings, `${link} names a heading that does not exist`).toContain(anchor);
    }
  });

  // The page says what the project runs today. These fail when that stops being true, so the
  // page is corrected in the same change instead of quietly going stale.
  it("is still right that the registry is on testnet only", () => {
    expect(custody).toMatch(/on\s+testnet today/);
    const deployments = JSON.parse(read("contracts/deployments.json")) as {
      testnet: { registry: string | null };
      public: { registry: string | null; attester: string | null };
    };
    expect(deployments.testnet.registry).toBeTruthy();
    expect(
      deployments.public,
      "a mainnet registry is deployed: docs/custody.md still says testnet only, update both",
    ).toMatchObject({ registry: null, attester: null });
  });

  it("is still right that the reference corridor refuses anything but testnet", () => {
    expect(custody).toMatch(/refuses a manifest that is not for\s+testnet/);
    const workflow = read(".github/workflows/reference-corridor.yml");
    expect(workflow).toContain("scripts/assert-testnet-corridor.ts");
    expect(existsSync(resolve(process.cwd(), "scripts/assert-testnet-corridor.ts"))).toBe(
      true,
    );
  });
});
