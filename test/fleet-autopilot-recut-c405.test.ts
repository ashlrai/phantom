import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_AUTOPILOT_SCHEMA,
  planFleetAutopilot,
  readFleetAutopilotState,
  type FleetAutopilotState,
} from '../src/core/fleet/autopilot.js';
import { readFleetQueue, type FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { FleetAdmissionReport } from '../src/cli/fleet-admission.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const dirs: string[] = [];
async function tempRunsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-autopilot-recut-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
  await mkdir(join(dir, 'metrics'), { recursive: true });
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const now = new Date(2026, 10, 8, 12).getTime();

// ---------------------------------------------------------------------------
// carried hunk: readFleetQueue depDetail -> metDeps (stale-park signal)
// ---------------------------------------------------------------------------

describe('readFleetQueue depDetail metDeps (RQ-PHX-RECUTCOREFLEETC405)', () => {
  it('reports parked DEP rows whose gates all merged only when depDetail is set', async () => {
    const dir = await tempRunsDir();
    const stalePrompt = join(dir, 'queue', 'prompts', 'RQ-STALE.md');
    const waitPrompt = join(dir, 'queue', 'prompts', 'RQ-WAIT.md');
    await writeFile(stalePrompt, 'DEPENDENCY GATE: RQ-UP-A\n');
    await writeFile(waitPrompt, 'DEPENDENCY GATE: RQ-UP-A, RQ-UP-B\n');
    await writeFile(join(dir, 'queue', 'ready.tsv'), [
      `PARKED-DEP.devin\tRQ-STALE\tdevin\twork\tphantom\t${stalePrompt}`,
      `PARKED-DEP.codex-local\tRQ-WAIT\tcodex-local\twork\tphantom\t${waitPrompt}`,
      'READY\tRQ-RUN\tdevin\twork\tphantom\tprompts/r.md',
    ].join('\n'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-UP-A' })}\n`);

    const plain = await readFleetQueue({ runsDir: dir, now: () => now });
    expect(plain.unmetDeps).toEqual([{ job: 'RQ-WAIT', lane: 'codex-local', unmet: ['RQ-UP-B'] }]);
    expect(plain.metDeps).toBeUndefined();

    const detail = await readFleetQueue({ runsDir: dir, now: () => now, depDetail: true });
    expect(detail.unmetDeps).toEqual([{ job: 'RQ-WAIT', lane: 'codex-local', unmet: ['RQ-UP-B'] }]);
    expect(detail.metDeps).toEqual([{ job: 'RQ-STALE', lane: 'devin', gates: ['RQ-UP-A'] }]);
    expect(JSON.stringify(detail)).not.toContain(stalePrompt);
  });
});

// ---------------------------------------------------------------------------
// carried file: fleet autopilot planning cycle
// ---------------------------------------------------------------------------

const admission = (
  lanes: FleetAdmissionReport['lanes'], cap = 10, running = 10, atCap = true,
): FleetAdmissionReport => ({
  schema: 'fleet.admission.v1', readOnly: true, status: 'ok',
  global: { cap, running, load1: 1, admit_reason: null, at_cap: atCap, closed: atCap, non_cap_closed: false },
  lanes,
});

const lane = (
  name: string, running: number, target: number, queued: number, held = false,
): FleetAdmissionReport['lanes'][number] => ({ lane: name, running, target, queued, held, reason: 'ok', status: 'ok' });

const queueView = (patch: Partial<FleetQueueV1> = {}): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-11-08T00:00:00.000Z',
  sources: { ready: 'healthy', skips: 'healthy' },
  total: 0, ready: 0, parked: 0, malformed: 0,
  byLane: [], nextUp: [], groups: [], unmetDeps: [], metDeps: [], skips: [], skipsLast24h: 0,
  ...patch,
});

const slotLane = (name: string, target: number, held = false): LaneTargetsV1['lanes'][number] => ({
  lane: name, target, floor: 0, ceiling: 8, held, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null,
});

const state = (patch: Partial<FleetAutopilotState> = {}): FleetAutopilotState => ({
  generatedAt: '2026-11-08T00:00:00.000Z',
  sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' },
  admission: admission([]), queue: queueView(), slots: { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] },
  rebase: null,
  ...patch,
});

describe('planFleetAutopilot', () => {
  it('proposes an unpark sweep for stale parked deps (metDeps)', () => {
    const report = planFleetAutopilot(state({
      admission: admission([lane('devin', 2, 2, 0)]),
      queue: queueView({
        byLane: [{ lane: 'devin', ready: 0, parked: 2 }],
        metDeps: [
          { job: 'RQ-A', lane: 'devin', gates: ['RQ-G1'] },
          { job: 'RQ-B', lane: 'devin', gates: ['RQ-G2'] },
        ],
      }),
      slots: { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [slotLane('devin', 2)] },
    }));
    expect(report.schema).toBe(FLEET_AUTOPILOT_SCHEMA);
    expect(report.topGap?.kind).toBe('stale-parked-deps');
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'unpark', count: 2 });
  });

  it('holds an over-deep lane when a starved lane is blocked at the cap', () => {
    const report = planFleetAutopilot(state({
      admission: admission([lane('devin', 0, 2, 4), lane('grok', 8, 4, 0)], 10, 8, true),
      queue: queueView({ byLane: [
        { lane: 'devin', ready: 4, parked: 0 },
        { lane: 'grok', ready: 14, parked: 0 },
      ] }),
      slots: { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [slotLane('devin', 2), slotLane('grok', 4)] },
    }));
    expect(report.topGap?.kind).toBe('starved-lane');
    expect(report.topGap?.lane).toBe('devin');
    expect(report.action).toMatchObject({ kind: 'hold-lane', lane: 'grok' });
  });

  it('answers no-op fleet-healthy when every lane is fed to target', () => {
    const report = planFleetAutopilot(state({
      admission: admission([lane('devin', 2, 2, 0)], 10, 2, false),
      queue: queueView({ byLane: [{ lane: 'devin', ready: 0, parked: 0 }] }),
      slots: { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [slotLane('devin', 2)] },
    }));
    expect(report.gaps).toEqual([]);
    expect(report.action).toMatchObject({ kind: 'no-op', reason: 'fleet-healthy' });
  });
});

describe('readFleetAutopilotState', () => {
  it('reads queue/status.json and injected sources through the real entry point', async () => {
    const dir = await tempRunsDir();
    await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({
      last_tick: '2026-11-08T00:00:00Z',
      admission: { cap: 8, running: 3, load1: 0.5, reason: null },
      lanes: { devin: { running: 3, target: 4, queued: 0, held: false } },
    }));
    const assembled = await readFleetAutopilotState({
      runsDir: dir,
      now: () => new Date('2026-11-08T00:00:00Z'),
      queue: async () => queueView({ ready: 1, byLane: [{ lane: 'devin', ready: 1, parked: 0 }] }),
      slots: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', lanes: [slotLane('devin', 4)] }),
    });
    expect(assembled.sources).toEqual({ status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' });
    expect(assembled.admission?.lanes[0]).toMatchObject({ lane: 'devin', running: 3, target: 4 });
    expect(planFleetAutopilot(assembled).readOnly).toBe(true);
  });

  it('degrades each source independently instead of throwing', async () => {
    const dir = await tempRunsDir(); // no status.json written
    const assembled = await readFleetAutopilotState({
      runsDir: dir,
      queue: async () => { throw new Error('queue broke'); },
      slots: async () => ({ v: 1, generatedAt: '', sourceState: 'degraded', lanes: [] }),
    });
    expect(assembled.sources.status).toBe('missing');
    expect(assembled.sources.queue).toBe('degraded');
    expect(assembled.sources.slots).toBe('degraded');
    const report = planFleetAutopilot(assembled);
    expect(report.action.kind).toBe('no-op');
  });
});
