/** Keeps docs/PARITY.md honest (RQ-TOOLPARITY-1). Reads repository files only. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listBusCliAdapters } from '../src/core/agents/bus-cli-adapters.js';

const root = join(__dirname, '..');
const parity = readFileSync(join(root, 'docs/PARITY.md'), 'utf8');

describe('docs/PARITY.md', () => {
  it('names every fleet lane, node worker host, teammate and desktop app', () => {
    const lanes = ['codex-cmp', 'codex-personal', 'codex-local', 'claude', 'claude-api', 'devin', 'devin-flash',
      'gemini', 'zai', 'agy', 'grok', 'cursor'];
    const others = ['mbp', 'muse', 'air', 'codex-file', 'dot', 'instinct', 'Grok Bot', 'Devin', 'Cursor'];
    for (const name of [...lanes, ...others]) expect(parity, name).toContain(name);
  });

  it('cites only source files that exist', () => {
    const cited = [...parity.matchAll(/`((?:src|contrib|test)\/[^`\s]+?\.(?:ts|sh|py))`/g)].map(m => m[1]!);
    expect(cited.length).toBeGreaterThan(4);
    for (const path of cited) expect(existsSync(join(root, path)), path).toBe(true);
  });

  it('matches the bus adapter provider claims', () => {
    const providers = new Map(listBusCliAdapters().map(a => [a.cli, a.providers as readonly string[]]));
    expect(providers.get('claude')).toContain('glm');
    expect(providers.get('codex')).toContain('local');
    expect([...providers.keys()]).not.toContain('gemini');
    expect(parity).toContain('none for `gemini` or `agy`');
  });

  it('is linked from the toolchain page and the docs index', () => {
    expect(readFileSync(join(root, 'docs/AGENT-TOOLCHAIN.md'), 'utf8')).toContain('PARITY.md');
    expect(readFileSync(join(root, 'docs/README.md'), 'utf8')).toContain('docs/PARITY.md');
  });
});
