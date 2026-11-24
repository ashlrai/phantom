import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdBundle } from '../src/cli/bundle.js';
import { listAgentProfiles, readAgentProfile, writeAgentProfile } from '../src/core/agents/agent-profile.js';
import { updateProfile } from '../src/core/connectors/profile.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-m2-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
const run = (args: string[]) => cmdBundle([...args, '--json'], { home });

describe('M2 bundle CLI acceptance', () => {
  it('exports, inspects, previews without writes, and applies an agent through the existing profile reader', async () => {
    const source = join(home, '.phantom', 'bots', 'reviewer');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'doctrine.md'), '# Reviewer\nDraft review notes.\n');
    await writeFile(join(source, 'memory-seed.md'), 'Keep review notes concise.\n');
    await writeAgentProfile({ id: 'reviewer', displayName: 'Reviewer', doctrine: 'bots/reviewer/doctrine.md' }, home);
    const path = join(home, 'reviewer.bundle.json');
    expect(await run(['export', 'agent', 'reviewer', '--out', path])).toBe(0);
    const bytes = await readFile(path, 'utf8');
    expect(bytes).not.toContain('Keep review notes concise.');
    expect(await run(['inspect', path])).toBe(0);
    expect(output()).toMatchObject({ schema: 'phantom.bundle.v1', kind: 'agent' });
    const before = await readdir(join(home, '.phantom', 'agents'));
    expect(await run(['import', path, '--as', 'reviewer-copy'])).toBe(0);
    expect(output().dryRun).toBe(true);
    expect(await readdir(join(home, '.phantom', 'agents'))).toEqual(before);
    expect(await run(['import', path, '--as', 'reviewer-copy', '--apply'])).toBe(0);
    expect(output().dryRun).toBe(false);
    expect(await readAgentProfile('reviewer-copy', home)).toMatchObject({ id: 'reviewer-copy', policy: { send: 'drafts-only', perMessageApproval: true }, mcpServers: [] });
    expect((await listAgentProfiles(home)).map(p => p.id)).toEqual(['reviewer', 'reviewer-copy']);
    expect(await run(['import', path, '--as', 'reviewer-copy', '--apply'])).toBe(2);
    const memoryPath = join(home, 'memory.bundle.json');
    expect(await run(['export', 'agent', 'reviewer', '--out', memoryPath, '--include-memory'])).toBe(0);
    expect(await readFile(memoryPath, 'utf8')).toContain('Keep review notes concise.');
  });

  it('exports and imports a tool as disabled metadata without changing the global connector store', async () => {
    await updateProfile(() => ({ version: 1, connectors: [{ id: 'lint.helper', kind: 'cli', command: 'eslint', args: [], scopes: [], tools: [], lanes: [], credentials: [] }] }), home);
    const globalPath = join(home, '.phantom', 'connectors', 'profile.toml');
    const before = await readFile(globalPath, 'utf8'), path = join(home, 'tool.bundle.json');
    expect(await run(['export', 'tool', 'lint.helper', '--out', path])).toBe(0);
    expect(await run(['import', path, '--as', 'lint-copy', '--apply'])).toBe(0);
    const imported = JSON.parse(await readFile(join(home, '.phantom', 'agents', 'lint-copy', 'connectors', 'lint.helper.json'), 'utf8'));
    expect(imported).toMatchObject({ enabled: false, bound: false, ownerEnableRequired: true });
    expect(await readFile(globalPath, 'utf8')).toBe(before);
  });

  it.each([
    ['import', 'missing.json'], ['import', 'missing.json', '--as', 'copy', '--enable'],
    ['inspect', 'missing.json', '--apply'], ['export', 'tool', 'x', '--out', 'x', '--include-memory'],
    ['import', 'missing.json', '--as', 'copy', '--apply', '--apply'],
  ])('refuses invalid arguments without creating a profile: %j', async args => {
    expect(await run(args)).toBe(2);
    expect(output()).toMatchObject({ ok: false });
    expect(await readdir(home)).toEqual([]);
  });
});
