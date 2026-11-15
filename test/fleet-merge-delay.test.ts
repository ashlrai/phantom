import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMergeDelay, cmdFleetMergeDelay, type MergeDelayEvent } from '../src/cli/fleet-merge-delay.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date('2026-11-02T12:00:00Z');
const event = (kind: MergeDelayEvent['event'], minute: number, pr = 1): MergeDelayEvent =>
  ({ repo: 'ashlrai/phantom', pr, event: kind, at: new Date(now.getTime() - minute * 60_000).toISOString() });
const complete = [event('merged', 5), event('published', 60), event('auto_merge_enabled', 40)];
describe('fleet merge-delay', () => {
  it('measures each stage from unordered events and ignores duplicate later observations', () => {
    expect(buildMergeDelay([...complete, event('published', 50)], now).rows[0]).toMatchObject({
      status: 'merged', publicationToEnrollmentSeconds: 1200, enrollmentToMergeSeconds: 2100,
      publicationToMergeSeconds: 3300, enrollmentWaitSeconds: null, mergeWaitSeconds: null, stalledEnrollment: false,
    });
  });
  it('keeps missing stages unknown even when merge is observed', () => {
    expect(buildMergeDelay([event('merged', 5)], now).rows[0]).toMatchObject({
      status: 'merged', publicationToEnrollmentSeconds: null, enrollmentToMergeSeconds: null,
      publicationToMergeSeconds: null, stalledEnrollment: false,
    });
  });
  it('flags stalled enrollment at the threshold and distinguishes waiting for merge', () => {
    const rows = buildMergeDelay([event('published', 30), event('published', 29, 2), event('auto_merge_enabled', 10, 3)], now).rows;
    expect(rows[0]).toMatchObject({ status: 'awaiting_enrollment', enrollmentWaitSeconds: 1800, stalledEnrollment: true });
    expect(rows[1]?.stalledEnrollment).toBe(false);
    expect(rows[2]).toMatchObject({ status: 'awaiting_merge', mergeWaitSeconds: 600, stalledEnrollment: false });
  });
  it('does not conflate PR numbers across repositories or invent negative durations', () => {
    const rows = buildMergeDelay([event('published', 5), event('auto_merge_enabled', 10),
      { ...event('merged', 1), repo: 'ashlrai/other' }], now).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.repo === 'ashlrai/phantom')).toMatchObject({ status: 'invalid_order', publicationToEnrollmentSeconds: null });
  });
  it('reports injected fixtures as JSON through the registered command', async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await cmdFleetMergeDelay(['--input', 'fixture.json', '--json'], {
      readEvents: async path => { expect(path).toBe('fixture.json'); return complete; }, now: () => now, output,
    })).toBe(0);
    expect(JSON.parse(output.log.mock.calls[0]![0])).toMatchObject({ schema: 'fleet.merge-delay.v1', rows: [{ publicationToMergeSeconds: 3300 }] });
    expect((await FLEET_SUBCOMMAND_LOADERS['merge-delay']!()).cmdFleetMergeDelay).toBe(cmdFleetMergeDelay);
  });
  it('reads an explicit JSON fixture file without injected I/O', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merge-delay-'));
    const path = join(dir, 'events.json');
    const output = { log: vi.fn(), error: vi.fn() };
    try {
      await writeFile(path, JSON.stringify(complete));
      expect(await cmdFleetMergeDelay(['--input', path, '--json'], { now: () => now, output })).toBe(0);
      expect(JSON.parse(output.log.mock.calls[0]![0]).rows).toHaveLength(1);
      await writeFile(path, '{}');
      expect(await cmdFleetMergeDelay(['--input', path], { output })).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('handles empty fixtures, help and plain output', async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    for (const events of [[], [event('published', 40)]]) {
      expect(await cmdFleetMergeDelay(['--input', 'fixture'], { readEvents: async () => events, now: () => now, output })).toBe(0);
    }
    expect(output.log.mock.calls[0]![0]).toBe('No PR events found.');
    expect(output.log.mock.calls[1]![0]).toContain('enrollment stalled');
    expect(await cmdFleetMergeDelay(['--help'], { output })).toBe(0);
  });
  it('rejects malformed, future and unreadable input without echoing it', async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    for (const events of [[{ ...event('published', 1), at: 'bad' }], [event('published', -1)], [null]]) {
      expect(await cmdFleetMergeDelay(['--input', 'fixture'], { readEvents: async () => events as MergeDelayEvent[], now: () => now, output })).toBe(1);
    }
    expect(await cmdFleetMergeDelay(['--input', 'fixture'], { readEvents: async () => { throw new Error('private'); }, output })).toBe(1);
    expect(JSON.stringify(output.error.mock.calls)).not.toContain('private');
    for (const args of [[], ['--input'], ['--bad'], ['--input', 'x', '--json', '--json']]) {
      expect(await cmdFleetMergeDelay(args, { output })).toBe(2);
    }
  });
});
