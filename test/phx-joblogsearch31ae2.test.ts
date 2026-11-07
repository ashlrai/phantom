import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail, type FleetJobDetailOptions } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

let runs: string;
const clock = () => new Date('2026-10-30T23:51:00.000Z');

beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'fake-job-search-')); });
afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

function setup() {
  const detail = vi.fn((id: string, options?: FleetJobDetailOptions) =>
    getFleetJobDetail(id, { ...options, runsDir: runs, now: clock }));
  const changes = vi.fn<typeof getFleetJobChanges>();
  const text = vi.fn<typeof getFleetJobText>();
  const output = { log: vi.fn(), stdout: vi.fn(), stderr: vi.fn() };
  return { deps: { detail, changes, text, output }, detail, changes, text, output };
}

describe('fleet job scrubbed tail search', () => {
  it('returns overlapping context once in source order with counts and source metadata', async () => {
    const lines = ['outside', 'before', 'hit [x]', 'between', 'hit [x] again', 'after', 'outside end'];
    await writeFile(join(runs, 'FAKE1.log'), `${lines.join('\n')}\n`);
    const { deps, detail, output } = setup();
    expect(await cmdFleetJobRead(['FAKE1', '--log', '--tail-lines', '6', '--log-find', 'hit [x]', '--context-lines', '1', '--json'], deps)).toBe(0);
    expect(detail).toHaveBeenCalledExactlyOnceWith('FAKE1', { maxTailLines: 6 });
    expect(JSON.parse(output.log.mock.calls[0]![0] as string)).toEqual({
      schema: 'fleet.job.log.v1', job: 'FAKE1', generatedAt: clock().toISOString(),
      log: { source: 'live', bytes: Buffer.byteLength(`${lines.join('\n')}\n`), tail: lines.slice(1, 6), truncated: true },
      sources: { log: 'healthy' }, matchCount: 2, scannedLines: 6,
    });
    expect(output.stderr).not.toHaveBeenCalled();
  });

  it('prints literal, case-sensitive matches and clipped context as text', async () => {
    await writeFile(join(runs, 'FAKE1.log'), 'Hit .*\nhit .*\nmiddle\nhit .*\n--json\n');
    const { deps, output } = setup();
    expect(await cmdFleetJobRead(['FAKE1', '--log', '--log-find', 'hit .*', '--context-lines', '10'], deps)).toBe(0);
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith('Hit .*\nhit .*\nmiddle\nhit .*\n--json\n');
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith('Log: live; health: healthy; truncated: no; scrubbed tail search: 2 matching lines / 5 scanned\n');
    expect(await cmdFleetJobRead(['FAKE1', '--log', '--log-find', 'hit .*'], deps)).toBe(0);
    expect(output.stdout).toHaveBeenLastCalledWith('hit .*\nhit .*\n');
    expect(await cmdFleetJobRead(['FAKE1', '--log', '--log-find=--json', '--context-lines', '0'], deps)).toBe(0);
    expect(output.stdout).toHaveBeenLastCalledWith('--json\n');
  });

  it('distinguishes zero matches, missing and degraded logs, and searches only scrubbed lines', async () => {
    await writeFile(join(runs, 'FAKE1.log'), 'normal line\nAuthorization: Bearer fake-placeholder\n');
    await symlink(join(runs, 'FAKE1.log'), join(runs, 'FAKE3.log'));
    const { deps, output } = setup();
    for (const [id, source, health, scanned] of [
      ['FAKE1', 'live', 'healthy', 2], ['FAKE2', 'missing', 'missing', 0], ['FAKE3', 'missing', 'degraded', 0],
    ] as const) {
      expect(await cmdFleetJobRead([id, '--log', '--log-find', 'fake-placeholder', '--json'], deps)).toBe(0);
      const result = JSON.parse(output.log.mock.calls.at(-1)![0] as string);
      expect(result).toMatchObject({ log: { source, tail: [], truncated: false }, sources: { log: health }, matchCount: 0, scannedLines: scanned });
      expect(JSON.stringify(result)).not.toContain('fake-placeholder');
    }
    expect(await cmdFleetJobRead(['FAKE1', '--log', '--log-find', '[redacted line]'], deps)).toBe(0);
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith('[redacted line]\n');
  });

  it('rejects invalid search options before invoking any reader, including with help', async () => {
    const { deps, detail, changes, text } = setup();
    const invalid = [
      ['FAKE1', '--log-find', 'x'], ['FAKE1', '--log', '--context-lines', '1'],
      ['FAKE1', '--changes', '--log-find', 'x'], ['--help', '--log-find', 'x'],
      ['FAKE1', '--log', '--log-find'], ['FAKE1', '--log', '--log-find', ''],
      ['FAKE1', '--log', '--log-find='],
      ['FAKE1', '--log', '--log-find', '--json'], ['FAKE1', '--log', '--log-find', 'x', '--log-find', 'y'],
      ['FAKE1', '--log', '--log-find', 'x', '--context-lines'],
      ...['-1', '11', '1.5', '1e0', '1\n', '999999999999999999999'].map(n => ['FAKE1', '--log', '--log-find', 'x', '--context-lines', n]),
      ['FAKE1', '--log', '--log-find', 'x', '--context-lines', '0', '--context-lines', '1'],
    ];
    for (const args of invalid) expect(await cmdFleetJobRead(args, deps), args.join(' ')).toBe(2);
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });
});
