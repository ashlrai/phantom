import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Catalog slice for PR #5315 (RQ-PHX-INTENTEDITMCPRECOVER229S): the native
// intent_add / intent_update tools are registered in src/core/mcp-native.ts but
// were missing from docs/MCP-TOOLS.md. This test binds each catalog row to the
// actual registration source as text — no runtime imports of Tier-1 modules.

const root = process.cwd();
const registrySource = readFileSync(join(root, 'src/core/mcp-native.ts'), 'utf8');
const catalogSource = readFileSync(join(root, 'docs/MCP-TOOLS.md'), 'utf8');

const INTENT_EDIT_TOOLS = ['intent_add', 'intent_update'] as const;

/** Extract the registered description for a native tool from mcp-native.ts source text. */
function registeredDescription(toolName: string): string {
  const pattern = new RegExp(
    `name:\\s*['"]${toolName}['"],\\s*\\n\\s*description:\\s*['"]([^'"]+)['"]`,
  );
  const match = registrySource.match(pattern);
  expect(match, `${toolName} registration with description not found in src/core/mcp-native.ts`).not.toBeNull();
  return match![1]!;
}

/** Extract every catalog table row for a tool name, preserving row order. */
function catalogRows(toolName: string): string[] {
  const pattern = new RegExp(`^\\|\\s*\`${toolName}\`\\s*\\|\\s*([^|]+?)\\s*\\|`, 'gm');
  return [...catalogSource.matchAll(pattern)].map(match => match[1]!);
}

describe('intent_add / intent_update MCP catalog rows', () => {
  it.each(INTENT_EDIT_TOOLS)('%s is registered exactly once in the native registry source', toolName => {
    const registrations = registrySource.match(new RegExp(`name:\\s*['"]${toolName}['"]`, 'g')) ?? [];
    expect(registrations).toHaveLength(1);
  });

  it.each(INTENT_EDIT_TOOLS)('%s has exactly one catalog row matching the registered description', toolName => {
    const rows = catalogRows(toolName);
    expect(rows, `${toolName} catalog rows in docs/MCP-TOOLS.md`).toHaveLength(1);
    expect(rows[0]).toBe(registeredDescription(toolName));
  });
});
