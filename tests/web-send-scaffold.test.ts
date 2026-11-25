import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level checks for the /send scaffold (RFC 0004 §6, #684). The web app
// has no component test runner; `pnpm --filter web build` covers rendering.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("send app scaffold and permanent testnet banner (#684)", () => {
  it("the banner says testnet and no real money, and has no way to dismiss it", () => {
    const banner = read("web/components/send/TestnetBanner.tsx");
    expect(banner).toContain("Testnet only. No real money.");
    expect(banner).toContain('role="note"');
    // Permanent: no client state, no handlers, no close control.
    expect(banner).not.toMatch(/"use client"|useState|onDismiss|onClose|onClick|<button/);
  });

  it("every /send screen renders through a layout that always shows the banner", () => {
    const layout = read("web/app/send/layout.tsx");
    expect(layout).toContain("<TestnetBanner />");
    expect(layout).toContain("{children}");
    // The banner must not sit behind a condition.
    expect(layout).not.toMatch(/\{[^}]*&&\s*<TestnetBanner/);
    // The root layout already renders <main>; a second one is invalid.
    expect(layout).not.toContain("<main");
    expect(read("web/app/layout.tsx")).toContain("<main");
  });

  it("the /send page exists and the navbar links to it", () => {
    expect(read("web/app/send/page.tsx")).toContain("Send a testnet payment");
    expect(read("web/components/layout/Navbar.tsx")).toContain(
      '{ href: "/send", label: "Send" }',
    );
  });

  it("the navbar wraps instead of overflowing at narrow widths", () => {
    const navbar = read("web/components/layout/Navbar.tsx");
    expect(navbar).toMatch(/<nav aria-label="Main" className="[^"]*flex-wrap/);
  });
});
