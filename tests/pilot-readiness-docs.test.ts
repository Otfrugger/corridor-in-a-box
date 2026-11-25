import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const checklist = read("docs/pilot-readiness.md");

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
const anchorOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");

describe("pilot readiness checklist", () => {
  it("is linked from the runbook", () => {
    expect(read("docs/operations.md")).toContain("(./pilot-readiness.md)");
  });

  it("links only to pages and headings that exist", () => {
    const links = [...checklist.matchAll(/\]\((\.[^)\s]+)\)/g)].map((match) => match[1] ?? "");
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

  // The checklist tells an operator what to type and what to set. Each of these fails when the
  // thing it names is renamed or removed, so the checklist is corrected in the same change.
  it("names only settings that exist", () => {
    const envExample = read(".env.example");
    for (const name of checklist.match(/\bCORRIDOR_[A-Z_]+\b/g) ?? []) {
      expect(envExample, `${name} is not in .env.example`).toContain(name);
    }
    const manifestSchema = read("packages/manifest/src/index.ts");
    for (const field of ["max_amount", "rollback", "timeout_seconds", "refund_wait_seconds"]) {
      expect(checklist).toContain(field);
      expect(manifestSchema, `${field} is not in the manifest schema`).toContain(field);
    }
    expect(manifestSchema).toContain("canary_max_amount");
  });

  it("names only commands the runbook documents", () => {
    const runbook = read("docs/operations.md");
    const commands = [
      "corridor runs list --state held",
      "corridor runs resolve",
      "corridor breaker status",
      "corridor breaker reset",
      "--dry-run",
      "--network public",
    ];
    for (const command of commands) {
      expect(checklist, `the checklist no longer mentions "${command}"`).toContain(command);
      expect(runbook, `"${command}" is not in docs/operations.md`).toContain(command);
    }
  });

  it("is still right that the canary command takes only a raw seed", () => {
    expect(checklist).toMatch(/has no KMS option/);
    const wiring = read("packages/cli/src/wire.ts");
    expect(wiring).toContain("CORRIDOR_SIGNER_SECRET");
    expect(
      /VaultTransitSigner|AwsKmsSigner|GcpKmsSigner|CORRIDOR_SIGNER\b(?!_SECRET)/.test(wiring),
      "the canary can now sign through a KMS: update the canary note in docs/pilot-readiness.md",
    ).toBe(false);
  });

  it("is still right that there is no mainnet registry to read", () => {
    expect(checklist).toMatch(/no registry on mainnet yet/);
    const deployments = JSON.parse(read("contracts/deployments.json")) as {
      public: { registry: string | null };
    };
    expect(
      deployments.public.registry,
      "a mainnet registry is deployed: update section 7 of docs/pilot-readiness.md",
    ).toBeNull();
  });
});
