import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const REPO_ROOT = import.meta.dirname.split("test")[0];

describe("SUPPORT.md", () => {
  it("exists at the repository root", () => {
    const p = join(REPO_ROOT, "SUPPORT.md");
    if (!existsSync(p)) {
      throw new Error("SUPPORT.md not found at repository root");
    }
  });

  it("links SECURITY.md", () => {
    const p = join(REPO_ROOT, "SUPPORT.md");
    const content = readFileSync(p, "utf-8");
    if (!content.includes("SECURITY.md")) {
      throw new Error("SUPPORT.md must contain a link to SECURITY.md");
    }
    if (!content.match(/SECURITY\.md/)) {
      throw new Error("SUPPORT.md must contain a link to SECURITY.md");
    }
  });

  it("every relative markdown link resolves", () => {
    const p = join(REPO_ROOT, "SUPPORT.md");
    const content = readFileSync(p, "utf-8");
    const links = content.match(/\[.+?\]\(.+?\)/g) ?? [];
    const failures: string[] = [];
    for (const m of links) {
      const href = m.match(/\((.+)\)/)?.[1];
      if (!href) continue;
      // Only check relative (non-absolute) links
      if (href.startsWith("http") || href.startsWith("#")) continue;
      const target = join(REPO_ROOT, href);
      if (!existsSync(target)) {
        failures.push(`${href} → ${target}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Relative links that do not resolve: ${failures.join(", ")}`,
      );
    }
  });
});
