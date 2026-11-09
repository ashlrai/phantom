import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const toolNames = extractToolNames(
  readFileSync(join(root, 'docs/MCP-TOOLS.md'), 'utf8'),
);

describe('MCP tools documentation', () => {
  it(`includes ${toolNames.length} tool names from the doc`, () => {
    expect(toolNames.length).toBeGreaterThan(20);
  });

  it.each(toolNames)('tool "%s" declared in the native or desktop operator registry', toolName => {
    const sources = [
      readFileSync(join(root, 'src/core/mcp-native.ts'), 'utf8'),
      readFileSync(join(root, 'src/core/desktop/operator-mcp.ts'), 'utf8'),
    ].join('\n');
    const pattern = new RegExp(`name:\\s*['"]${escapeRegex(toolName)}['"]|tool\\(\\s*['"]${escapeRegex(toolName)}['"]`);
    expect(sources, `${toolName} missing from the native and desktop operator registries`).toMatch(pattern);
  });
});

/**
 * Extract tool names from MCP-TOOLS.md table rows.
 * Matches the first backtick-enclosed identifier in each table row cell.
 */
function extractToolNames(md: string): string[] {
  const tools: string[] = [];
  const rows = md.split('\n');
  for (const row of rows) {
    if (!row.startsWith('|')) continue;
    // Match the tool name cell: | `tool_name` | ...
    const match = row.match(/^\|\s*`([^`]+)`/);
    if (match && match[1]) tools.push(match[1]);
  }
  // de-duplicate while preserving order
  return [...new Set(tools)];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
