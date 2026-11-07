import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncDocs } from '../src/core/docs-sync.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-sync-')); roots.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs-sync.toml'), `version = 1\nname = "example"\ndocsDir = "docs"\nagentsFile = "AGENTS.md"\nllmsFile = "docs/llms.txt"\nllmsFullFile = "docs/llms-full.txt"\nllmsReferenceFile = "docs/reference.txt"\nhostedDir = "site/docs"\nregistry = "configured"\ncliName = "example"\nsiteOrigin = "https://example.com"\ncommands = ["status"]\n`);
  writeFileSync(join(root, 'AGENTS.md'), '# Agents\n');
  writeFileSync(join(root, 'docs/llms.txt'), '# Index\n');
  writeFileSync(join(root, 'docs/reference.txt'), '# Reference\n');
  writeFileSync(join(root, 'docs/status.md'), '# status\n\nInspect status.\n\n```sh\nexample status --json\n```\n');
  return root;
}
describe('docs sync', () => {
  it('writes deterministic outputs and detects changes without writing in check mode', () => {
    const root = fixture();
    expect(syncDocs(root, undefined, false).ok).toBe(true);
    expect(syncDocs(root, undefined, true)).toMatchObject({ ok: true, drift: [], missing: [] });
    const before = readFileSync(join(root, 'docs/llms.txt'), 'utf8');
    writeFileSync(join(root, 'docs/new.md'), '# New\n');
    const result = syncDocs(root, undefined, true);
    expect(result.ok).toBe(false);
    expect(result.drift).toContain('docs/llms.txt');
    expect(readFileSync(join(root, 'docs/llms.txt'), 'utf8')).toBe(before);
    expect(readFileSync(join(root, 'docs/llms-full.txt'), 'utf8')).toContain('https://example.com/docs/status.md');
  });
  it('reports missing section and real shell example independently', () => {
    const root = fixture();
    writeFileSync(join(root, 'docs/status.md'), '# Overview\n\n```text\nexample status\n```\n');
    expect(syncDocs(root, undefined, false).missing).toEqual([{ command: 'status', section: false, example: false }]);
  });
  it('rejects paths outside the checkout', () => {
    const root = fixture();
    const path = join(root, 'docs-sync.toml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('agentsFile = "AGENTS.md"', 'agentsFile = "../outside"'));
    expect(() => syncDocs(root, undefined, false)).toThrow(/outside checkout/);
  });
});
