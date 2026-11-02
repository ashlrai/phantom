import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const REPO_ROOT = import.meta.dirname.split("test")[0];
const DOC = join(REPO_ROOT, "docs", "LANE-HOLDS.md");

describe("LANE-HOLDS.md", () => {
  it("exists at docs/LANE-HOLDS.md", () => {
    if (!existsSync(DOC)) {
      throw new Error("docs/LANE-HOLDS.md not found");
    }
  });

  it("contains all five field names", () => {
    const content = readFileSync(DOC, "utf-8");
    const fields = ["`held`", "`heldReason`", "`heldUntil`", "`lastChange`", "`changedBy`"];
    for (const f of fields) {
      if (!content.includes(f)) {
        throw new Error(`Missing field name: ${f}`);
      }
    }
  });

  it("contains the lanes API path", () => {
    const content = readFileSync(DOC, "utf-8");
    if (!content.includes("/api/verse/fleet/control/lanes")) {
      throw new Error("Missing /api/verse/fleet/control/lanes");
    }
  });

  it("contains 'autobackoff'", () => {
    const content = readFileSync(DOC, "utf-8");
    if (!content.includes("autobackoff")) {
      throw new Error("Missing 'autobackoff'");
    }
  });

  it("contains no absolute home directory path", () => {
    const content = readFileSync(DOC, "utf-8");
    const matches = content.match(/\/Users\//g);
    if (matches && matches.length > 0) {
      throw new Error(
        `Found absolute home path(s): ${matches.length} occurrence(s) of /Users/`
      );
    }
  });
});
