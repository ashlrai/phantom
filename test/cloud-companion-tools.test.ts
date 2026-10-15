/**
 * Companion-tools block for cloud task prompts (src/core/cloud/companion-tools.ts):
 * names only the companion servers a checkout's .mcp.json declares.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { companionToolsBlock, companionToolsBlockFor, declaredMcpServers } from '../src/core/cloud/companion-tools.js';

const dirs: string[] = [];
const checkout = (mcpJson?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-companions-'));
  dirs.push(dir);
  if (mcpJson !== undefined) writeFileSync(join(dir, '.mcp.json'), mcpJson);
  return dir;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('companion tools block', () => {
  it('is empty without a .mcp.json, with an unreadable one, or with no companion servers', () => {
    expect(companionToolsBlockFor(checkout())).toBe('');
    expect(companionToolsBlockFor(checkout('{not json'))).toBe('');
    expect(companionToolsBlockFor(checkout('{"mcpServers":[]}'))).toBe('');
    expect(companionToolsBlockFor(checkout('{"mcpServers":{"other":{"command":"x"}}}'))).toBe('');
  });

  it('names only the declared companions, with the read-only and no-pin rules', () => {
    const dir = checkout(JSON.stringify({ mcpServers: { 'phantom-secrets': {}, locus: {}, other: {} } }));
    expect(declaredMcpServers(dir)).toEqual(['phantom-secrets', 'locus', 'other']);
    const block = companionToolsBlockFor(dir);
    expect(block).toContain('`phantom_check`');
    expect(block).toContain('"no active pin" means do not act as any account');
    expect(block).not.toContain('lexicon');
    expect(block).not.toContain('stack_apply');
    expect(block).toContain('"toolsUsed"');
  });

  it("covers every server in the repo's own .mcp.json", () => {
    const block = companionToolsBlock(declaredMcpServers(process.cwd()));
    for (const name of ['phantom-secrets', 'locus', 'lexicon', 'stack']) expect(block).toContain(`\`${name}\``);
    expect(block).toContain('never call `stack_add` or `stack_apply`');
  });
});
