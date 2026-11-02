/**
 * Validation for docs/PANES.md — the machine-readable pane catalogue.
 *
 * Four assertions:
 * 1. The file begins with "# Phantom console panes".
 * 2. Every id declared in code (first `id:` string literal, or the
 *    TERMINAL_PANE_ID constant when no literal id exists) appears in the
 *    doc table as a backticked cell.
 * 3. Every backticked id in the doc table rows exists in code.
 * 4. Every source file path listed in the table exists on disk.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const PANES_MD = join(ROOT, "docs", "PANES.md");
const VERSE_DIR = join(ROOT, "src", "web-ui", "routes", "verse");

/** Scan all *.pane.tsx files and extract their registered id. */
function collectPanesFromCode(): Set<string> {
  const ids = new Set<string>();
  const files = readdirSync(VERSE_DIR, { recursive: true });
  for (const rel of files) {
    if (!rel.endsWith(".pane.tsx")) continue;
    const abs = join(VERSE_DIR, rel);
    const src = readFileSync(abs, "utf-8");

    // Check for a terminal-style constant export first
    const constMatch = src.match(
      /export\s+const\s+[A-Z_]+_PANE_ID\s*=\s*'([a-z-]+)'/,
    );
    if (constMatch) {
      ids.add(constMatch[1]);
      continue;
    }

    // Normal: first id: 'xxx' literal
    const idMatch = src.match(/id:\s*'([a-z-]+)'/);
    if (idMatch) {
      ids.add(idMatch[1]);
    }
  }
  return ids;
}

/** Parse backticked ids from the doc table body rows. */
function collectIdsFromDoc(text: string): Set<string> {
  const ids = new Set<string>();
  // Match backticked strings in the table rows (after the header line)
  const backtickRegex = /`([a-z][a-z0-9-]*)`/g;
  let match: RegExpExecArray | null;
  const lines = text.split("\n");
  let inTable = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("| Id")) {
      inTable = true;
      continue;
    }
    if (inTable && line.trimStart().startsWith("|")) {
      while ((match = backtickRegex.exec(line)) !== null) {
        ids.add(match[1]);
      }
    }
    if (inTable && line.trimStart().startsWith("##")) {
      break;
    }
  }
  return ids;
}

/** Extract source-file paths from the doc table. */
function collectSourcePathsFromDoc(text: string): string[] {
  const paths: string[] = [];
  // Regex literal — \/ is a forward slash, \` and ` are literal backticks
  const pathRegex = /`src\/web-ui\/routes\/verse\/[a-z0-9\/_-]+\.pane\.tsx`/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    paths.push(match[0].replace(/^`|`$/g, ""));
  }
  return paths;
}

describe("docs/PANES.md", () => {
  it('starts with "# Phantom console panes"', () => {
    const text = readFileSync(PANES_MD, "utf-8");
    const firstLine = text.split("\n")[0];
    expect(firstLine).toBe("# Phantom console panes");
  });

  it("every id declared in code appears in the doc table", () => {
    const text = readFileSync(PANES_MD, "utf-8");
    const codeIds = collectPanesFromCode();
    const docIds = collectIdsFromDoc(text);

    for (const id of codeIds) {
      expect(
        docIds.has(id),
        `Pane id "${id}" exists in code but is missing from the doc table`,
      ).toBe(true);
    }
  });

  it("every backticked id in the doc exists in code", () => {
    const text = readFileSync(PANES_MD, "utf-8");
    const codeIds = collectPanesFromCode();
    const docIds = collectIdsFromDoc(text);

    for (const id of docIds) {
      expect(
        codeIds.has(id),
        `Id "${id}" appears in the doc but no pane.tsx declares it`,
      ).toBe(true);
    }
  });

  it("every source path in the table exists on disk", () => {
    const text = readFileSync(PANES_MD, "utf-8");
    const paths = collectSourcePathsFromDoc(text);

    expect(paths.length).toBeGreaterThan(0, "PANES.md should list pane sources");

    for (const relPath of paths) {
      const full = join(ROOT, relPath);
      expect(
        readFileSync(full, "utf-8").length,
        `Source file "${relPath}" listed in PANES.md does not exist`,
      ).toBeGreaterThan(0);
    }
  });
});
