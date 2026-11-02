import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const REPO_ROOT = import.meta.dirname.split("test")[0];

function extractInterfaceProps(sourcePath: string): string[] {
  const content = readFileSync(sourcePath, "utf-8");
  // Match `export interface NAME { ... }` blocks and extract property names
  // before a colon, stripping any generics like `<T>`
  const blocks = content.matchAll(
    /export interface\s+(\w+)\s*\{([^}]+)\}/gs,
  );
  const props: string[] = [];
  for (const m of blocks) {
    const ifaceName = m[1];
    const body = m[2];
    const nameMatches = body.matchAll(/\b(\w+)(?:<[^>]+>)?\s*:/g);
    for (const nm of nameMatches) {
      props.push(nm[1]);
    }
  }
  return [...new Set(props)];
}

describe("docs/RESOURCE-LEDGER.md", () => {
  it("exists at docs/RESOURCE-LEDGER.md", () => {
    const p = join(REPO_ROOT, "docs/RESOURCE-LEDGER.md");
    if (!existsSync(p)) {
      throw new Error("docs/RESOURCE-LEDGER.md not found");
    }
  });

  it("contains the API route and CLI command", () => {
    const p = join(REPO_ROOT, "docs/RESOURCE-LEDGER.md");
    const content = readFileSync(p, "utf-8");
    if (!content.includes("/api/verse/leader/resources")) {
      throw new Error("Missing '/api/verse/leader/resources' in document");
    }
    if (!content.includes("ashlr resources ledger")) {
      throw new Error("Missing 'ashlr resources ledger' in document");
    }
  });

  it("every property declared in the four interfaces appears backticked in the document", () => {
    const src = join(
      REPO_ROOT,
      "src/core/fleet/runs-resource-ledger.ts",
    );
    if (!existsSync(src)) {
      throw new Error("Source file runs-resource-ledger.ts not found");
    }
    const docPath = join(REPO_ROOT, "docs/RESOURCE-LEDGER.md");
    const docContent = readFileSync(docPath, "utf-8");

    // Extract all property names from the four source-interface blocks
    const props = extractInterfaceProps(src);

    // Also pull properties from the LaneDeadSignal interface in the
    // lane-dead-signal source, because ResourceLaneRow.deadSignal
    // references it and its fields should be documented too.
    const ldsSrc = join(
      REPO_ROOT,
      "src/core/fleet/lane-dead-signal.ts",
    );
    if (existsSync(ldsSrc)) {
      props.push(...extractInterfaceProps(ldsSrc));
    }

    const missing: string[] = [];
    for (const prop of props) {
      // Check the backticked property appears anywhere in the doc
      const backticked = `\`${prop}\``;
      if (!docContent.includes(backticked)) {
        missing.push(prop);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Properties from source interfaces not found in the document: ${missing.join(", ")}`,
      );
    }
  });
});
