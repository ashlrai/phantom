/**
 * `phm commands`: the catalog is the CLI help table, nothing else. These tests
 * fail when a command is dispatched but not listed, listed but not dispatched,
 * or classified read-only under a name that no longer exists.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdCommands } from '../src/cli/commands.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { buildCommandCatalog, commandLine, READ_ONLY_COMMANDS, type CatalogCommand } from '../src/core/commands/catalog.js';
import { createCommandsApi } from '../src/core/verse/commands-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { buildPaletteItems } from '../src/web-ui/routes/verse/shell/palette-model.js';
import { dispatchedCommands } from './helpers/cli-command-table.js';

const catalog = buildCommandCatalog(HELP_ENTRIES);
const names = catalog.map((command) => command.name);
afterEach(() => vi.restoreAllMocks());

describe('command catalog', () => {
  it('lists every dispatched command, and nothing that is not dispatched', () => {
    const dispatched = dispatchedCommands(readFileSync(join(__dirname, '..', 'src', 'cli', 'index.ts'), 'utf8'));
    const firstWords = new Set(names.map((name) => name.split(' ')[0]!));
    expect(dispatched.filter((cmd) => !firstWords.has(cmd))).toEqual([]);
    expect([...firstWords].filter((word) => !dispatched.includes(word))).toEqual([]);
  });

  it('covers every help row under one unique name with a description', () => {
    expect(new Set(names).size).toBe(names.length);
    expect(HELP_ENTRIES.filter((row) => !names.some((name) => row.cmd === name || row.cmd.startsWith(`${name} `)))).toEqual([]);
    expect(catalog.filter((command) => !command.description.trim() || command.arguments.length === 0)).toEqual([]);
  });

  it('has no stale read-only classification', () => {
    expect([...READ_ONLY_COMMANDS].filter((name) => !names.includes(name))).toEqual([]);
    expect(catalog.find((command) => command.name === 'fleet status')).toMatchObject({ changesState: false, needsInput: false });
    // Views merged after the catalog was written; the palette runs them in place.
    for (const name of ['home', 'map']) expect(catalog.find((command) => command.name === name)).toMatchObject({ changesState: false, needsInput: false });
    expect(catalog.find((command) => command.name === 'job')).toMatchObject({ changesState: true });
  });

  it('merges rows that share a name and treats an unclassified command as state-changing', () => {
    const built = buildCommandCatalog([
      { cmd: 'world  get <path> [--json]', desc: 'Read one node.' },
      { cmd: 'mystery [--json]', desc: 'First.' },
      { cmd: 'mystery set <key>', desc: 'Different name.' },
      { cmd: 'mystery <id>', desc: 'Second form.' },
      { cmd: 'completions zsh|bash', desc: 'Print a script.' },
    ]);
    expect(built).toEqual([
      { name: 'world get', description: 'Read one node.', arguments: ['<path> [--json]'], changesState: false, needsInput: true },
      { name: 'mystery', description: 'First.', arguments: ['[--json]', '<id>'], changesState: true, needsInput: false },
      { name: 'mystery set', description: 'Different name.', arguments: ['<key>'], changesState: true, needsInput: true },
      { name: 'completions', description: 'Print a script.', arguments: ['zsh|bash'], changesState: true, needsInput: true },
    ]);
    expect(built.map(commandLine)).toEqual(['phm world get <path> [--json]', 'phm mystery', 'phm mystery set <key>', 'phm completions zsh|bash']);
  });
});

describe('desktop palette', () => {
  it('has exactly one entry per catalog command, each carrying that command (no drift)', () => {
    const items = buildPaletteItems({ cli: catalog, needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' })
      .filter((item) => item.group === 'cli');
    expect(items.map((item) => (item.payload.kind === 'cli' ? item.payload.command : null))).toEqual(catalog);
    expect(items.map((item) => item.title)).toEqual(names.map((name) => `phm ${name}`));
    expect(new Set(items.map((item) => item.key)).size).toBe(catalog.length);
  });
});

describe('phm commands', () => {
  it('prints the catalog as JSON and as text, and rejects an unknown argument', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdCommands(['--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ schema: 'phantom.commands.v1', commands: catalog });
    log.mockClear();
    expect(await cmdCommands([])).toBe(0);
    const text = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(text).toMatch(/^fleet status\s+read-only\s+Read-only fleet snapshot/m);
    expect(text).toMatch(/^tidy\s+changes state /m);
    expect(text).toContain('phm tidy [--apply]');
    expect(await cmdCommands(['--bogus'])).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/verse/commands', () => {
  const fixture: CatalogCommand[] = [
    { name: 'fleet status', description: 'Read.', arguments: ['[--json]'], changesState: false, needsInput: false },
    { name: 'tidy', description: 'Move files.', arguments: ['[--apply]'], changesState: true, needsInput: false },
    { name: 'run show', description: 'Print a run.', arguments: ['<id>'], changesState: false, needsInput: true },
  ];
  async function call(target: string, method = 'GET') {
    const run = vi.fn(async () => ({ exitCode: 0, output: 'ok' }));
    const out = { status: 0, body: '' };
    const res = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.body = b ?? ''; }, setHeader: () => {}, statusCode: 0 } as unknown as ServerResponse;
    const handled = await createCommandsApi(run, async () => fixture)({} as VerseApiContext, { url: target } as IncomingMessage, res, target.split('?')[0]!, method);
    return { handled, status: out.status, json: out.body ? JSON.parse(out.body) : null, run };
  }

  it('serves the same catalog shape as the CLI', async () => {
    expect(await call('/api/verse/commands')).toMatchObject({ handled: true, status: 200, json: { schema: 'phantom.commands.v1', commands: fixture } });
    expect((await call('/api/verse/other')).handled).toBe(false);
  });

  it('runs a read-only command with the catalog name as argv', async () => {
    const result = await call('/api/verse/commands/run?name=fleet%20status');
    expect(result).toMatchObject({ status: 200, json: { exitCode: 0, output: 'ok' } });
    expect(result.run).toHaveBeenCalledWith(['fleet', 'status']);
  });

  it.each([
    ['/api/verse/commands/run?name=tidy', 'GET', 403],
    ['/api/verse/commands/run?name=run%20show', 'GET', 403],
    ['/api/verse/commands/run?name=fleet%20status%20--apply', 'GET', 404],
    ['/api/verse/commands/run?name=fleet%20status', 'POST', 405],
  ])('never runs %s (%s)', async (target, method, status) => {
    const result = await call(target, method);
    expect(result.status).toBe(status);
    expect(result.run).not.toHaveBeenCalled();
  });
});


it('an optional-only command alternative stays bare without hiding required input', () => {
  const rows = buildCommandCatalog([
    { cmd: 'map [--json] | map edges [--since 10m]', desc: 'Read the map.' },
    { cmd: 'inspect <path> | <id>', desc: 'Inspect an item.' },
  ]);
  expect(rows[0]).toMatchObject({ name: 'map', changesState: false, needsInput: false });
  expect(commandLine(rows[0]!)).toBe('phm map');
  expect(rows[1]).toMatchObject({ name: 'inspect', changesState: true, needsInput: true });
});
