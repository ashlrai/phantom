import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReadyTsv } from '../fleet/lane-console.js';
import type { PlannerHealth } from '../fleet/planner-failover.js';
import { readStatusSupply, summarizeStatusSupply, supplyLines, type StatusSupply } from './status-supply-line.js';

const at = '2026-11-01T10:56:44.000Z';
const ok: PlannerHealth = { status: 'ok', lastGoodPassAt: at, failingSince: null, resetAt: null, reason: null };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'status-supply-')); dirs.push(dir); return dir; };

describe('status supply projection', () => {
  it('counts headered and positional queues, excluding parked and unlisted lanes', () => {
    const header = parseReadyTsv([
      'id\tstatus\tpool',
      'RQ-PHX-ONE\tREADY\tcodex-personal',
      'FILL-ONE\tREADY\tcodex-personal',
      'RQ-PHX-TWO\tPARKED-BYHAND\tcodex-local',
      'RQ-PHX-THREE\tREADY\tPARKED-BYHAND.codex-local',
      'RQ-PHX-FOUR\tREADY\tprivate-lane',
      'RQ-PHX-FIVE\tRUNNING\tdevin',
    ].join('\n'));
    const positional = parseReadyTsv('READY\tRQ-PHX-SIX\tdevin\nREADY\tFILL-TWO\tcodex-local');
    expect(header.dropped + positional.dropped).toBe(0);
    const result = summarizeStatusSupply([...header.rows, ...positional.rows], ok, 'healthy');
    expect(result.lanes).toEqual([
      { lane: 'codex-personal', phxReady: 1, fillerReady: 1 },
      { lane: 'devin', phxReady: 1, fillerReady: 0 },
      { lane: 'codex-local', phxReady: 0, fillerReady: 1 },
    ]);
    expect(supplyLines(result)).toEqual([
      'Supply: codex-personal 1 phantom / 1 filler; devin 1 / 0; codex-local 0 / 1',
      `Planner: last good pass ${at}`,
    ]);
  });

  it('formats empty and unavailable supply and each planner status', () => {
    const empty = summarizeStatusSupply([], ok, 'healthy');
    expect(supplyLines(empty)).toEqual(['Supply: none ready', `Planner: last good pass ${at}`]);
    const failing = summarizeStatusSupply([], { ...ok, status: 'failing', reason: 'usage-limit', failingSince: at }, 'degraded');
    expect(supplyLines(failing)).toEqual(['Supply: unavailable', `Planner: failing (usage-limit) since ${at}`]);
    const unknown = summarizeStatusSupply([], { ...ok, status: 'unknown', reason: 'no-leader-rows' }, 'missing');
    expect(supplyLines(unknown)).toEqual(['Supply: unavailable', 'Planner: unknown (no-leader-rows)']);
  });

  it('never renders untrusted lane names, counts, reason text or timestamps', () => {
    const supply: StatusSupply = { v: 1, sourceState: 'healthy', lanes: [
      { lane: 'secret\nprivate', phxReady: 1, fillerReady: 0 },
      { lane: 'devin', phxReady: -1, fillerReady: 0 },
    ], planner: { status: 'failing', lastGoodPassAt: at, failingSince: 'secret', reason: 'secret' } };
    expect(supplyLines(supply)).toEqual(['Supply: none ready', 'Planner: unknown (unavailable)']);
  });

  it('reads a missing queue without throwing and still reports planner health', async () => {
    const dir = tempDir();
    expect(await readStatusSupply(dir, () => new Date(at))).toEqual({
      v: 1, sourceState: 'missing', lanes: [],
      planner: { status: 'unknown', lastGoodPassAt: null, failingSince: null, reason: 'missing-events-log' },
    });
  });

  it('reads queue and failure streak timestamps from the existing readers', async () => {
    const dir = tempDir(); mkdirSync(join(dir, 'queue'));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), 'READY\tRQ-PHX-ONE\tdevin\nREADY\tFILL\tdevin\n');
    writeFileSync(join(dir, 'queue', 'dispatch-events.log'), '2026-11-01 00:00:00 LEADER fixups=0\n2026-11-01 00:01:00 LEADER executor rc=1\n');
    const result = await readStatusSupply(dir, () => new Date(at));
    expect(result.lanes).toEqual([{ lane: 'devin', phxReady: 1, fillerReady: 1 }]);
    expect(result.planner.status).toBe('failing');
    expect(result.planner.lastGoodPassAt).not.toBe(result.planner.failingSince);
    expect(supplyLines(result)[1]).toMatch(/^Planner: failing \(executor-fail\) since \d{4}-\d\d-\d\dT/);
  });
});
