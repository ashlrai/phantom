import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignSpecialist, findSpecialist, loadSpecialistRoster, parseSpecialistRoster,
  recordSpecialistOutcome, saveSpecialistRoster, setSpecialistCurrentJob,
  SPECIALIST_ROSTER_SCHEMA, withSpecialistRosterLock,
} from '../src/core/fleet/roster.js';
import {
  appendSpecialistOutcome, loadSpecialistPreamble, renderSpecialistOutcome, renderSpecialistPreamble,
} from '../src/core/fleet/specialist-memory.js';
import { cmdFleetRoster } from '../src/cli/fleet-roster.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const roots: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'specialists-'));
  roots.push(directory);
  const roster = assignSpecialist(await loadSpecialistRoster(directory), 'grokbot', 'fleet routing');
  return { directory, roster, specialist: findSpecialist(roster, 'grokbot') };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('persistent specialist roster', () => {
  it('round-trips identities, preferences, jobs and stats through an atomic private file', async () => {
    const { directory, roster } = await fixture();
    roster.specialists[0]!.callsign = 'Grokbot';
    roster.specialists[0]!.allowedLanes = ['grok'];
    roster.specialists[0]!.allowedModels = ['grok-code'];
    const working = setSpecialistCurrentJob(roster, 'grokbot', 'RQ-1');
    await saveSpecialistRoster(working, directory);
    expect(await loadSpecialistRoster(directory)).toEqual(working);
    const updated = assignSpecialist(working, 'grokbot', 'queue ownership');
    await saveSpecialistRoster(updated, directory);
    expect((await loadSpecialistRoster(directory)).specialists[0]).toEqual({ ...working.specialists[0], domain: 'queue ownership' });
    expect(await readdir(directory)).toEqual(['roster.json']);
    expect((await stat(join(directory, 'roster.json'))).mode & 0o777).toBe(0o600);
    expect(roster.specialists[0]!.currentJob).toBeNull();
  });

  it('does not create state on a missing read and refuses corrupt or invalid snapshots', async () => {
    const { directory, roster } = await fixture();
    expect(await readdir(directory)).toEqual([]);
    await saveSpecialistRoster(roster, directory);
    const original = await readFile(join(directory, 'roster.json'), 'utf8');
    const invalid = structuredClone(roster);
    invalid.specialists.push(invalid.specialists[0]!);
    await expect(saveSpecialistRoster(invalid, directory)).rejects.toThrow();
    expect(await readFile(join(directory, 'roster.json'), 'utf8')).toBe(original);
    await writeFile(join(directory, 'roster.json'), '{');
    await expect(loadSpecialistRoster(directory)).rejects.toThrow();
    expect(() => parseSpecialistRoster({ schema: 'unknown', specialists: [] })).toThrow();
    expect(() => assignSpecialist(roster, 'grokbot', '\u0001')).toThrow();
  });

  it.each(['../escape', '/absolute', 'UPPER', 'x/y'])('rejects unsafe identity %s', async id => {
    const { roster } = await fixture();
    expect(() => assignSpecialist(roster, id, 'domain')).toThrow();
  });

  it('rejects memory redirection and impossible stats', async () => {
    const { roster } = await fixture();
    for (const patch of [{ memoryPath: '../outside.md' }, { stats: { jobs: 1, merges: 2, reverts: 0, emptyRate: 0 } },
      { stats: { jobs: 1, merges: 0, reverts: 0, emptyRate: NaN } }]) {
      expect(() => parseSpecialistRoster({ ...roster, specialists: [{ ...roster.specialists[0], ...patch }] })).toThrow();
    }
  });

  it('counts actual outcomes and clears job metadata without mutating prior snapshots', async () => {
    const { roster } = await fixture();
    let next = setSpecialistCurrentJob(roster, 'grokbot', 'RQ-2');
    for (const outcome of ['empty', 'merged', 'reverted', 'failed'] as const) next = recordSpecialistOutcome(next, 'grokbot', outcome);
    expect(next.specialists[0]!.stats).toEqual({ jobs: 4, merges: 2, reverts: 1, emptyRate: 0.25 });
    expect(next.specialists[0]!.currentJob).toBeNull();
    expect(roster.specialists[0]!.stats.jobs).toBe(0);
  });

  it('serializes writers, releases locks on failure, and rejects symlinked snapshots', async () => {
    const { directory } = await fixture();
    await withSpecialistRosterLock(directory, async () => {
      await expect(withSpecialistRosterLock(directory, async () => undefined)).rejects.toThrow();
    });
    await expect(withSpecialistRosterLock(directory, async () => { throw new Error('failure'); })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    const target = join(directory, 'outside');
    await writeFile(target, JSON.stringify({ schema: SPECIALIST_ROSTER_SCHEMA, specialists: [] }));
    await symlink(target, join(directory, 'roster.json'));
    await expect(loadSpecialistRoster(directory)).rejects.toThrow();
  });
});

describe('specialist memory', () => {
  it('appends outcomes with all convention sections and loads context across jobs', async () => {
    const { directory, specialist } = await fixture();
    const first = { job: 'RQ-1', outcome: 'merged' as const, summary: 'routing fixed', at: '2026-11-14T00:00:00Z',
      decisions: ['prefer quota evidence'], pitfalls: ['missing is unknown'], filesTouched: ['src/core/fleet/roster.ts'], conventions: ['ESM imports'] };
    await appendSpecialistOutcome(specialist, first, directory);
    const before = await readFile(join(directory, specialist.memoryPath), 'utf8');
    await appendSpecialistOutcome(specialist, { job: 'RQ-2', outcome: 'failed', summary: 'retry tomorrow' }, directory);
    const after = await readFile(join(directory, specialist.memoryPath), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    for (const section of ['Decisions', 'Pitfalls', 'Files touched', 'Conventions']) expect(before).toContain(`### ${section}`);
    const preamble = await loadSpecialistPreamble(specialist, directory);
    for (const text of ['grokbot', 'fleet routing', 'routing fixed', 'retry tomorrow', 'does not override']) expect(preamble).toContain(text);
    expect((await stat(join(directory, specialist.memoryPath))).mode & 0o777).toBe(0o600);
  });

  it('renders missing memory without creating files and bounds old context', async () => {
    const { directory, specialist } = await fixture();
    expect(await loadSpecialistPreamble(specialist, directory)).toContain('No recorded outcomes');
    expect(await readdir(directory)).toEqual([]);
    const preamble = renderSpecialistPreamble(specialist, 'old-marker\n' + 'Historical decision about routing.\n'.repeat(500) + 'recent-marker');
    expect(preamble).not.toContain('old-marker');
    expect(preamble).toContain('recent-marker');
    expect(preamble.length).toBeLessThan(13000);
    expect(() => renderSpecialistOutcome({ job: 'x', outcome: 'failed', summary: 'x', at: 'bad' })).toThrow();
  });

  it('scrubs home paths and synthetic secrets at persistence and rendering boundaries', async () => {
    const { directory, roster, specialist } = await fixture();
    const synthetic = 'ghp_' + 'a'.repeat(36);
    roster.specialists[0]!.domain = `/Users/example/private /home/example/private ${synthetic}`;
    await saveSpecialistRoster(roster, directory);
    await appendSpecialistOutcome(specialist, { job: 'RQ-3', outcome: 'completed', summary: `${directory}/private ${synthetic}`,
      filesTouched: ['/Users/example/private/code.ts', '/home/example/file.ts'] }, directory);
    const serialized = await readFile(join(directory, 'roster.json'), 'utf8');
    const memory = await readFile(join(directory, specialist.memoryPath), 'utf8');
    const preamble = renderSpecialistPreamble(roster.specialists[0]!, memory + '\n/Users/other/hidden ' + synthetic);
    for (const result of [serialized, memory, preamble]) {
      for (const privateText of ['/Users/example', '/home/example', '/Users/other', synthetic, directory]) expect(result).not.toContain(privateText);
    }
  });

  it('refuses symlinked memory files and directories', async () => {
    const { directory, specialist } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'specialist-outside-')); roots.push(outside);
    await symlink(outside, join(directory, 'memory'));
    await expect(appendSpecialistOutcome(specialist, { job: 'x', outcome: 'empty', summary: 'x' }, directory)).rejects.toThrow();
    await expect(loadSpecialistPreamble(specialist, directory)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await rm(join(directory, 'memory'));
    await appendSpecialistOutcome(specialist, { job: 'x', outcome: 'empty', summary: 'x' }, directory);
    await rm(join(directory, specialist.memoryPath));
    const target = join(outside, 'keep.md'); await writeFile(target, 'untouched');
    await symlink(target, join(directory, specialist.memoryPath));
    await expect(appendSpecialistOutcome(specialist, { job: 'x', outcome: 'empty', summary: 'x' }, directory)).rejects.toThrow();
    await expect(loadSpecialistPreamble(specialist, directory)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });
});

it('exposes the CLI through the generated registry and handles the full local lifecycle', async () => {
  const { directory } = await fixture();
  const output: string[] = [], errors: string[] = [];
  const deps = { directory, out: (line: string) => output.push(line), err: (line: string) => errors.push(line) };
  const run = (...args: string[]) => cmdFleetRoster([...args, '--json'], deps);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['roster']!())['cmdFleetRoster']).toBe('function');
  expect(await run('list')).toBe(0);
  expect(JSON.parse(output.pop()!).specialists).toEqual([]);
  expect(await run('assign', 'grokbot', 'fleet')).toBe(0);
  expect(await run('note', 'grokbot', 'Prefer small patches')).toBe(0);
  expect(await run('show', 'grokbot')).toBe(0);
  expect(JSON.parse(output.pop()!).specialist.domain).toBe('fleet');
  expect(await readFile(join(directory, 'memory/grokbot.md'), 'utf8')).toContain('Prefer small patches');
  expect(await run('show', 'unknown')).toBe(1);
  expect(await run('assign', '../bad', 'fleet')).toBe(1);
  for (const args of [['list', 'extra'], ['list', '--wat'], ['list', '--json'], ['note', 'grokbot']]) expect(await run(...args)).toBe(2);
  expect(errors.join('\n')).not.toContain(directory);
  const missing = join(directory, 'never-created');
  expect(await cmdFleetRoster(['--help'], { ...deps, directory: missing })).toBe(0);
  expect(await readdir(directory)).not.toContain('never-created');
});
