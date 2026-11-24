/** Fixture tests for the palette's Commands group: wire validation, ranking and the confirm step. */
import { describe, expect, it } from 'vitest';
import type { CatalogCommand } from '../../../../core/commands/catalog.js';
import { cliStep, paletteCliCommands } from './palette-commands.js';
import { buildPaletteItems, paletteView } from './palette-model.js';

const command = (name: string, description: string, over: Partial<CatalogCommand> = {}): CatalogCommand =>
  ({ name, description, arguments: [''], changesState: true, needsInput: false, ...over });
const CLI_FIXTURE: CatalogCommand[] = [
  command('fleet status', 'Read-only fleet snapshot.', { arguments: ['[--json]'], changesState: false }),
  command('tidy', 'Show or apply tidy moves for loose Desktop files.', { arguments: ['[--apply]'] }),
  command('run show', 'Print a past run in detail.', { arguments: ['<id>'], changesState: false, needsInput: true }),
  command('worklog', 'One feed of what the fleet did.', { arguments: ['[--hours 6]'], changesState: false }),
  command('status', 'Attention board: dirty and stale repos.', { arguments: ['[--json]'], changesState: false }),
];

function view(query: string) {
  const items = buildPaletteItems({ cli: CLI_FIXTURE, needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
  return paletteView(items, query, [], 'mac');
}
const cliTitles = (query: string) => view(query).groups.find((group) => group.id === 'cli')?.items.map((item) => item.title) ?? [];

describe('search ranking', () => {
  it('puts a name match above a description match, in catalog order on a tie', () => {
    expect(cliTitles('fleet')).toEqual(['phm fleet status', 'phm worklog']);
    expect(cliTitles('status')).toEqual(['phm status', 'phm fleet status']);
  });

  it('finds a command by its description or an argument', () => {
    expect(cliTitles('desktop files')).toEqual(['phm tidy']);
    expect(cliTitles('--hours')).toEqual(['phm worklog']);
  });

  it('highlights the only match, but never above a desktop action for the same words', () => {
    const only = view('worklog');
    expect(only.flat[only.best]!.title).toBe('phm worklog');
    const shared = view('status');
    expect(shared.flat[shared.best]!.title).toBe('Autonomy status');
    expect(shared.groups.map((group) => group.id)).toContain('cli');
  });

  it('lists no commands for an empty query and none for a miss', () => {
    expect(cliTitles('')).toEqual([]);
    expect(view('zzqx-nothing').flat).toEqual([]);
  });
});

describe('the confirm step', () => {
  it('runs only a read-only command that needs nothing; anything that changes state asks first', () => {
    expect(CLI_FIXTURE.map(cliStep)).toEqual(['run', 'confirm', 'fill', 'run', 'run']);
    expect(cliStep(command('daemon start', 'Start.', { needsInput: true }))).toBe('confirm');
  });
});

describe('wire validation', () => {
  it('keeps well-formed rows and drops the rest', () => {
    expect(paletteCliCommands({ schema: 'phantom.commands.v1', commands: [...CLI_FIXTURE, { name: 'x' }, null, { ...CLI_FIXTURE[0], changesState: 'no' }] })).toEqual(CLI_FIXTURE);
    expect(paletteCliCommands(null)).toEqual([]);
    expect(paletteCliCommands({ commands: 'nope' })).toEqual([]);
  });
});
