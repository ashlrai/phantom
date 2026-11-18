import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDocsCli, cliReferenceRows } from '../src/cli/docs-cli.js';
import { cmdDocs, HELP_ENTRIES } from '../src/cli/help.js';
import { CLI_REFERENCE_PATH, checkCliReference, renderCliReference } from '../src/core/commands/cli-reference.js';

const registry = [
  { cmd: 'status [--json]', desc: 'Read status.' },
  { cmd: 'queue list --limit <n> [--json]', desc: 'Read queued work.' },
  { cmd: 'legacy', desc: 'Print text.' },
];
let root: string;
let path: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docs-cli-test-'));
  path = join(root, CLI_REFERENCE_PATH);
  await mkdir(join(root, 'docs'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('CLI reference generator with a fixture registry', () => {
  it('accepts an up-to-date page without writing', async () => {
    await writeFile(path, renderCliReference(registry));
    const before = await stat(path);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDocsCli(['--check', '--json'], registry, root)).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ schema: 'phantom.cli-reference.v1', ok: true,
      check: true, updated: false, commands: 3, missing: [], removed: [], stale: [], formatting: false });
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each([
    ['missing', registry.slice(1), registry, 'status [--json]'],
    ['removed', registry, registry.slice(0, 2), 'legacy'],
    ['stale', registry.map(row => ({ ...row, desc: 'Old summary.' })), registry, 'status [--json]'],
  ])('lists %s commands plainly and leaves the page untouched', async (kind, previous, current, command) => {
    const page = renderCliReference(previous);
    await writeFile(path, page);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDocsCli(['--check'], current, root)).toBe(1);
    expect(log.mock.calls.flat()).toContain(`${kind}: phm ${command}`);
    expect(await readFile(path, 'utf8')).toBe(page);
  });

  it('reports a missing page as missing commands, then regenerates and checks cleanly', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDocsCli(['--check', '--json'], registry, root)).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).missing).toHaveLength(registry.length);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cmdDocsCli([], registry, root)).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(renderCliReference(registry));
    expect(await cmdDocsCli(['--json'], registry, root)).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).updated).toBe(false);
    expect(await cmdDocsCli(['--check'], registry, root)).toBe(0);
  });

  it('is deterministic across registry order and preserves flags and JSON examples', () => {
    const page = renderCliReference(registry);
    expect(renderCliReference([...registry].reverse())).toBe(page);
    expect(renderCliReference(registry)).toBe(page);
    expect(page).toContain('| <code>--json</code>, <code>--limit</code> | <code>phm queue list --limit &lt;n&gt; --json</code> |');
    expect(page).toContain('| <code>phm legacy</code> | Print text. | - | - |');
    expect(renderCliReference([{ cmd: 'release [--json | --text]', desc: 'Status.' }]))
      .toContain('| <code>phm release --json</code> |');
  });

  it('catches flag changes, duplicate rows, escaped usage, and non-command drift', () => {
    const rows = [{ cmd: 'list|show <id> [--json]', desc: 'Read a | b & <c>.' }];
    const page = renderCliReference(rows);
    expect(checkCliReference(rows, page).ok).toBe(true);
    expect(checkCliReference(rows, renderCliReference([...rows, ...rows])).stale).toEqual([rows[0]!.cmd]);
    expect(checkCliReference(rows, page.replace('<code>--json</code>', '<code>--text</code>')).stale).toEqual([rows[0]!.cmd]);
    expect(checkCliReference(rows, `${page}\n`)).toMatchObject({ ok: false, formatting: true });
  });

  it('handles help and bad usage without writing, and reports IO errors as JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDocsCli(['--help'], registry, root)).toBe(0);
    expect(await cmdDocsCli(['--unknown', '--json'], registry, root)).toBe(2);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: false });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(path);
    expect(await cmdDocsCli(['--check', '--json'], registry, root)).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('routes docs cli to the shared generator using the real registry', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDocs(['cli', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).commands).toBe(cliReferenceRows(HELP_ENTRIES).length);
    expect(await cmdDocs(['cli', '--check', '--json'])).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(renderCliReference(cliReferenceRows(HELP_ENTRIES)));
  });
});
