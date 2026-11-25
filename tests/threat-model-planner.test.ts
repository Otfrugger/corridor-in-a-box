import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The planner section of the threat model is written ahead of the code it describes,
// so most of its rows name an issue and some name code that is already on main. Both
// kinds of claim can go stale without anyone noticing: an issue reference that links
// nowhere, a symbol that was renamed, a row left with neither. This holds the section
// to the rule it was written under: every threat has a mitigation or an open issue.

const repo = (path: string) => resolve(process.cwd(), path);
const doc = readFileSync(repo("docs/threat-model.md"), "utf8").replace(/\r\n/g, "\n");

const HEADING = "### 3.4 Planner ↔ Price Sources, Route Options and Lane Checks";

/**
 * The text of the planner section, from its heading up to the next heading. Empty
 * when the heading is missing, which the first test below reports by name.
 */
function plannerSection(): string {
  const start = doc.indexOf(`\n${HEADING}\n`);
  if (start === -1) return "";
  const rest = doc.slice(start + HEADING.length + 2);
  const next = rest.search(/^#{1,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const planner = plannerSection();
/** The same text without the link definitions, which must not count as uses of themselves. */
const prose = planner.replace(/^\[#\d+\]: \S+$/gm, "");

interface ThreatRow {
  readonly threat: string;
  readonly today: string;
  readonly tracked: string;
}

/** Every row of the three threat tables. */
function threatRows(): ThreatRow[] {
  return planner
    .split("\n")
    .filter(
      (line) => line.startsWith("| ") && !line.startsWith("| Threat") && !/^\| -+/.test(line),
    )
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      expect(cells, `not a three-column threat row: ${line.slice(0, 60)}`).toHaveLength(3);
      return { threat: cells[0]!, today: cells[1]!, tracked: cells[2]! };
    });
}

/** `symbol` in [`path`](../path): how the section cites code, by file and symbol. */
const CODE_CITATION = /`([^`]+)` in \[`([^`]+)`\]\(\.\.\/([^)#]+)\)/g;
const ISSUE_REFERENCE = /\[#(\d+)\]/g;

describe("threat model: the route planner", () => {
  it("covers the three risks the planner brought with it", () => {
    expect(doc, "the planner section is missing from docs/threat-model.md").toContain(
      `\n${HEADING}\n`,
    );
    for (const named of [
      "manipulated price source",
      "tampered route option",
      "stale lane check",
    ]) {
      expect(planner, named).toContain(named);
    }
    for (const table of [
      "**Rate history: the price source**",
      "**Route options: the planner, the service and the engine**",
      "**Lane checks**",
    ]) {
      expect(planner, table).toContain(table);
    }
  });

  it("gives every threat a mitigation in code or an open issue", () => {
    const rows = threatRows();
    // Ten on the price source, ten on route options, seven on lane checks.
    expect(rows).toHaveLength(27);

    for (const row of rows) {
      const cited = [...row.today.matchAll(CODE_CITATION)].length;
      const tracked = [...row.tracked.matchAll(ISSUE_REFERENCE)].length;
      expect(cited + tracked, `no mitigation and no issue: ${row.threat}`).toBeGreaterThan(0);
      // A row that admits nothing answers it yet must say which issue will.
      if (row.today.startsWith("Nothing yet.")) {
        expect(tracked, `nothing yet, and no issue either: ${row.threat}`).toBeGreaterThan(0);
      }
      expect(row.threat.length, "an empty threat cell").toBeGreaterThan(20);
    }
  });

  it("links every issue it names, and defines no link it does not use", () => {
    const used = new Set([...prose.matchAll(ISSUE_REFERENCE)].map((m) => m[1]!));
    const defined = new Map(
      [...doc.matchAll(/^\[#(\d+)\]: (\S+)$/gm)].map((m) => [m[1]!, m[2]!] as const),
    );

    expect(used.size).toBeGreaterThan(30);
    for (const n of used) {
      expect(defined.get(n), `[#${n}] is used but has no link`).toBe(
        `https://github.com/corridor-in-a-box/corridor-in-a-box/issues/${n}`,
      );
    }
    for (const n of defined.keys()) {
      expect(used.has(n), `[#${n}] is defined but never used`).toBe(true);
    }
  });

  it("cites code that exists, by a symbol that is still in the file", () => {
    const citations = [...prose.matchAll(CODE_CITATION)];
    // Enough of them that an empty match would be a broken pattern, not a clean doc.
    expect(citations.length).toBeGreaterThan(15);

    for (const [, symbol, shown, target] of citations) {
      expect(shown, "the path shown and the path linked differ").toBe(target);
      expect(existsSync(repo(target!)), `${target} does not exist`).toBe(true);
      expect(
        readFileSync(repo(target!), "utf8"),
        `${symbol} is no longer in ${target}`,
      ).toContain(symbol!);
    }
  });

  it("links the other document it leans on", () => {
    expect(planner).toContain("[`docs/route-resolver.md`](route-resolver.md)");
    expect(existsSync(repo("docs/route-resolver.md"))).toBe(true);
    // The heading the row points the reader to.
    expect(readFileSync(repo("docs/route-resolver.md"), "utf8")).toMatch(
      /^### Idempotency\r?$/m,
    );
  });

  it("sits among the trust boundaries, ahead of the attester's", () => {
    const boundaries = [...doc.matchAll(/^### (3\.\d) (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(boundaries).toEqual([
      "3.1 Engine ↔ Anchor HTTP",
      "3.2 Engine ↔ Horizon / Soroban RPC",
      "3.3 Service ↔ Client",
      "3.4 Planner ↔ Price Sources, Route Options and Lane Checks",
      "3.5 Attester ↔ Registry Contract",
    ]);
    // The introduction, the actors and the diagram all know about it.
    expect(doc).toContain("(section 3.4)");
    expect(doc).toContain("| **Rate Source** ");
    expect(doc).toContain("[ Route Planner (@corridor/router) ]");
  });
});
