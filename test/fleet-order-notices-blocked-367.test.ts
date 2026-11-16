import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderNotices } from '../src/cli/fleet-order-notices.js';
import type { OrderMergeNotice } from '../src/core/fleet/order-merge-notice.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const GEN = '2026-11-14T12:00:00.000Z';
const UNTIL = '2026-11-20T00:00:00Z';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'order-blocked-cli-'));
  dirs.push(dir);
  return dir;
};
const laneRow = (lane: string, held: boolean, extra: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane, target: 1, floor: 0, ceiling: 4, held, heldReason: 'MARKER-fake-hold-reason', heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: 'MARKER-fake-operator', ...extra,
});
const heldLanes = (extra: Partial<LaneTargetRow> = {}): LaneTargetsV1 => ({ v: 1, generatedAt: GEN,
  sourceState: 'healthy', lanes: [laneRow('fake-held', true, { heldUntil: UNTIL, ...extra })] });
const job = (lane: string | null, state: OrderTraceJob['state'] = 'queued',
  id = 'RQ-PHX-FAKEBLK1'): OrderTraceJob => ({ id, lane, state, url: null });
const trace = (jobs: OrderTraceJob[]): OrderTraceV1 => ({ v: 1, generatedAt: GEN,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' },
  orders: [{ at: '2026-11-14 08:00', source: 'desktop (fake-entry-1)', key: '11-14 08:00', jobs }] });
const blocked = trace([job('fake-held')]);

describe('fleet order-notices blocked lane notices', () => {
  it('dry run lists exactly one Blocked notice naming the held lane and writes nothing', async () => {
    const dir = root();
    const lines: string[] = [];
    const code = await cmdFleetOrderNotices(['--runs-dir', dir], {
      read: async () => blocked, lanes: async () => heldLanes(), output: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines.filter((line) => line.includes('Blocked:'))).toEqual([
      'desktop: Blocked: your 11-14 08:00 order waits on lane fake-held held until 2026-11-20T00:00:00.000Z.',
    ]);
    expect(lines.at(-1)).toBe('dry run: 1 notices; add --apply to send');
    expect(existsSync(join(dir, 'queue', 'order-notices.jsonl'))).toBe(false);
    expect(lines.join('\n')).not.toContain('MARKER');
  });

  it('--apply sends once and the ledger key is terminal on the second run', async () => {
    const dir = root();
    const send = vi.fn(async (_: OrderMergeNotice) => {});
    const lines: string[] = [];
    const deps = { read: async () => blocked, lanes: async () => heldLanes(),
      senders: { desktop: send }, output: (text: string) => lines.push(text) };
    expect(await cmdFleetOrderNotices(['--runs-dir', dir, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ channel: 'desktop', entryId: 'fake-entry-1', jobId: 'RQ-PHX-FAKEBLK1' });
    expect(readFileSync(join(dir, 'queue', 'order-notices.jsonl'), 'utf8')).toContain('"status":"sent"');
    expect(await cmdFleetOrderNotices(['--runs-dir', dir, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(lines[1]!)).toMatchObject({ sent: 0, skipped: 0, failed: 0, notices: [] });
    expect(send).toHaveBeenCalledOnce();
  });

  it('a changed held_until does not re-notify, but a second held lane does', async () => {
    const dir = root();
    const send = vi.fn(async (_: OrderMergeNotice) => {});
    const run = (t: OrderTraceV1, lanes: LaneTargetsV1) => cmdFleetOrderNotices(['--runs-dir', dir, '--apply', '--json'],
      { read: async () => t, lanes: async () => lanes, senders: { desktop: send }, output: () => {} });
    expect(await run(blocked, heldLanes())).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(await run(blocked, heldLanes({ heldUntil: '2026-12-01T00:00:00Z' }))).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    const twoJobs = trace([job('fake-held'), job('zeta-held', 'queued', 'RQ-PHX-FAKEBLK2')]);
    const twoLanes: LaneTargetsV1 = { v: 1, generatedAt: GEN, sourceState: 'healthy',
      lanes: [laneRow('fake-held', true, { heldUntil: '2026-12-01T00:00:00Z' }), laneRow('zeta-held', true)] };
    expect(await run(twoJobs, twoLanes)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].text).toContain('lane zeta-held held');
  });

  it('plans no blocked notice for jobs that are not all queued on held lanes', async () => {
    const dir = root();
    const lines: string[] = [];
    const cases: OrderTraceJob[][] = [
      [job('fake-held', 'merged')],
      [job('fake-held', 'launched')],
      [job('free-lane')],
      [job('ghost-lane')],
      [job(null)],
    ];
    for (const jobs of cases) {
      const lanes: LaneTargetsV1 = { v: 1, generatedAt: GEN, sourceState: 'healthy',
        lanes: [...heldLanes().lanes, laneRow('free-lane', false)] };
      expect(await cmdFleetOrderNotices(['--runs-dir', dir, '--json'], {
        read: async () => trace(jobs), lanes: async () => lanes, output: (text) => lines.push(text),
      })).toBe(0);
      const notices = JSON.parse(lines.at(-1)!).notices as OrderMergeNotice[];
      expect(notices.filter((notice) => notice.text.startsWith('Blocked:'))).toEqual([]);
    }
  });

  it('lanes unavailable still exits 0, plans no blocked notice, and merge notices go out', async () => {
    const send = vi.fn(async (_: OrderMergeNotice) => {});
    const merged = trace([{ id: 'RQ-PHX-FAKEMRG', lane: 'fake-held', state: 'merged',
      url: 'https://github.com/example/fake/pull/9' }]);
    const cases: Array<() => Promise<LaneTargetsV1>> = [
      async () => { throw new Error('slots gone'); },
      async () => ({ ...heldLanes(), sourceState: 'missing' }),
    ];
    for (const lanes of cases) {
      const lines: string[] = [];
      expect(await cmdFleetOrderNotices(['--runs-dir', root(), '--apply', '--json'], {
        read: async () => merged, lanes, senders: { desktop: send }, output: (text) => lines.push(text),
      })).toBe(0);
      const report = JSON.parse(lines[0]!);
      expect(report.notices).toHaveLength(1);
      expect(report.notices[0].text).toContain('Merged:');
      expect(report).toMatchObject({ sent: 1, failed: 0 });
    }
    expect(send).toHaveBeenCalledTimes(2);
    const lines: string[] = [];
    expect(await cmdFleetOrderNotices(['--runs-dir', root(), '--json'], {
      read: async () => blocked, lanes: async () => { throw new Error('slots gone'); },
      output: (text) => lines.push(text),
    })).toBe(0);
    expect(JSON.parse(lines[0]!).notices).toEqual([]);
  });

  it('reads held lanes from a real queue/slots.json when no lanes seam is injected', async () => {
    const dir = root();
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(join(dir, 'queue', 'slots.json'), JSON.stringify({
      'fake-held': { target: 0, floor: 0, ceiling: 2, held: true,
        held_until: UNTIL, held_reason: 'MARKER-slots-hold-reason' },
    }));
    const lines: string[] = [];
    expect(await cmdFleetOrderNotices(['--runs-dir', dir], {
      read: async () => blocked, output: (text) => lines.push(text),
    })).toBe(0);
    expect(lines.filter((line) => line.includes('Blocked:'))).toEqual([
      'desktop: Blocked: your 11-14 08:00 order waits on lane fake-held held until 2026-11-20T00:00:00.000Z.',
    ]);
    expect(lines.join('\n')).not.toContain('MARKER');
  });
});
