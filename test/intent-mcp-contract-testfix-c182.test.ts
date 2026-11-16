import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeToolDefs, listNativeTools } from '../src/core/mcp-native.js';
import { contractedNativeToolNames } from './helpers/native-tool-contract.js';

// Regression for the contract registration of the native intent evidence tools:
// every native tool must be documented in docs/MCP-TOOLS.md with a contracted
// prefix so the catalog-derived contract stays in lock with the code surface.
describe('intent_* native tools are contracted and documented', () => {
  it('intent_link and intent_ship appear in the doc-derived contract', () => {
    expect(contractedNativeToolNames).toContain('intent_link');
    expect(contractedNativeToolNames).toContain('intent_ship');
  });

  it('both tools are registered with append safety and a strict schema', () => {
    const defs = nativeToolDefs();
    for (const name of ['intent_link', 'intent_ship']) {
      const def = defs.find((tool) => tool.name === name);
      expect(def?.safety).toBe('append');
      expect(def?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('docs/MCP-TOOLS.md rows name both tools', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/MCP-TOOLS.md'), 'utf8');
    for (const name of ['intent_link', 'intent_ship']) {
      expect(doc).toContain(`\`${name}\``);
    }
  });

  it('tools/list exposes both tools with descriptions', () => {
    const listed = listNativeTools().filter((tool) => tool.name === 'intent_link' || tool.name === 'intent_ship');
    expect(listed).toHaveLength(2);
    for (const tool of listed) expect(tool.description.length).toBeGreaterThan(0);
  });
});
