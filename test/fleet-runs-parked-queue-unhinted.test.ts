import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const now = new Date(2026, 9, 31, 12).getTime();

async function queueWith(ready: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-unhinted-'));
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue', 'ready.tsv'), ready);
  return dir;
}

async function queueWithFiles(ready: string, routerQueue?: string) {
  const dir = await queueWith(ready);
  if (routerQueue !== undefined) await writeFile(join(dir, 'queue', 'router-queue.md'), routerQueue);
  return dir;
}

describe('fleet queue lane-open rows', () => {
  it('counts each ready job once using its first valid ready hint', async () => {
    const dir = await queueWith([
      'RQ-LANED\tphantom\tdevin\twork\tprompts/a.md',
      'RQ-LANED\tphantom\t\twork\tprompts/a.md',
      'RQ-LANED\tphantom\tclaude\twork\tprompts/a.md',
      'RQ-OPEN\tphantom\tclaude\twork\tprompts/b.md\t{"preferred_lane":null}',
      'RQ-OPEN\tphantom\tclaude\twork\tprompts/b.md',
      'RQ-OPEN\tphantom\t\twork\tprompts/b.md',
      'RQ-PARKED\tphantom\tPARKED-QUOTA.devin\twork\tprompts/c.md',
      'RQ-PARKED\tphantom\tdevin\twork\tprompts/c.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result).toMatchObject({
        total: 4, ready: 3, parked: 1, malformed: 0, unhinted: 1,
        sources: { ready: 'healthy' },
        health: { counts: { ready: 3 } },
      });
      expect(result.byLane).toMatchObject([{ lane: 'devin', ready: 2, parked: 1 }]);
      expect(result.nextUp).toEqual([{ lane: 'devin', jobs: ['RQ-LANED', 'RQ-PARKED'] }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('counts open-hint rows as ready work without degrading the source or inventing a lane', async () => {
    const dir = await queueWith([
      'RQ-OPEN-A\tphantom\t\twork\t/Users/x/prompts/a.md',
      'RQ-OPEN-B\tashlrai/phantom\t\tmid\tprompts/b.md\t{"preferred_lane":null}',
      'RQ-OPEN-C\tphantom\t\tfrontier\tprompts/c.md\t{"preferred_lane":"claude"}',
      // Restock rows: the requirements spec is authoritative over the lane
      // cell — explicit null reopens the row, a named lane overrides it.
      'RQ-SPEC-OPEN\tphantom\tdevin\twork\tprompts/s1.md\t{"preferred_lane":null}',
      'RQ-SPEC-LANE\tphantom\tdevin\twork\tprompts/s2.md\t{"preferred_lane":"claude"}',
      'RQ-LANED\tphantom\tdevin\twork\t/Users/x/prompts/d.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      // The rows naming no lane are open market work: runnable, counted,
      // but never attributed. The requirements' preferred_lane is the honest
      // lane when it names one — ahead of the legacy lane cell.
      expect(result).toMatchObject({
        total: 6, ready: 6, parked: 0, malformed: 0, unhinted: 3,
        sources: { ready: 'healthy' },
      });
      expect(result.byLane.map((row) => row.lane)).toEqual(['claude', 'devin']);
      expect(result.nextUp?.map((row) => row.lane)).toEqual(['claude', 'devin']);
      expect(result.health?.counts.ready).toBe(6);
      expect(JSON.stringify(result)).not.toContain('/Users/');
      expect(JSON.stringify(result)).not.toContain('prompts/');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps an open-shaped row malformed when the dialect guards fail, never repo-as-lane', async () => {
    const dir = await queueWith([
      'RQ-OPEN-D\tphantom\t\twork\tprompts/d.md',
      'RQ-BADLANE\tphantom\tnot a lane!\twork\tprompts/b.md',
      'RQ-BADPROMPT\tphantom\tnot a lane!\twork\tNOEXTENSION',
      'RQ-NORMAL\tphantom\tdevin\tmid\tprompts/n.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      // RQ-OPEN-D is genuinely lane-open; RQ-BADLANE's lane cell is not a
      // lane id the market accepts (invalid_requirements), and RQ-BADPROMPT
      // fails the dialect's prompt guard too — neither is open supply.
      expect(result).toMatchObject({
        total: 2, ready: 2, parked: 0, malformed: 2, unhinted: 1,
        sources: { ready: 'degraded' },
      });
      expect(result.byLane.map((row) => row.lane)).toEqual(['devin']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('resolves spec-less ready rows through their router-queue.md envelope', async () => {
    const dir = await queueWithFiles([
      'RQ-ENV-LANE\tphantom\tcodex\twork\tprompts/e1.md',
      'RQ-ENV-OPEN\tphantom\tclaude\twork\tprompts/e2.md',
      'RQ-ENV-POOL\tphantom\tcodex-local\tmid\tprompts/e3.md',
      'RQ-PLAIN\tphantom\tdevin\twork\tprompts/p.md',
      'RQ-SPECWIN\tphantom\tcodex\twork\tprompts/s.md\t{"preferred_lane":"claude"}',
    ].join('\n'), [
      '- READY RQ-ENV-LANE (P1, preferred_lane=devin): hinted work',
      '- READY RQ-ENV-OPEN (P2): the envelope names no lane — the row is open',
      '- CLAIMED 03:17 worker RQ-ENV-POOL (pool=claude-api): pool attr is the hint',
      '- READY RQ-SPECWIN (P1, pool=devin): the spec cell beats the envelope',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      // A matching envelope replaces the spec wholesale: preferred_lane wins
      // over the lane column, an envelope with no lane attrs is the open hint
      // (the lane column is never consulted), and pool=/lane= attrs resolve
      // like the market. RQ-PLAIN has no envelope — its lane column stands —
      // and RQ-SPECWIN's requirements cell beats its envelope.
      expect(result).toMatchObject({
        total: 5, ready: 5, parked: 0, malformed: 0, unhinted: 1,
        sources: { ready: 'healthy' },
      });
      expect(result.byLane).toEqual([
        { lane: 'claude', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
        { lane: 'claude-api', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
        { lane: 'devin', ready: 2, parked: 0, phantom: 2, other: 0, otherRepos: [] },
      ]);
      expect(result.nextUp).toEqual([
        { lane: 'claude', jobs: ['RQ-SPECWIN'] },
        { lane: 'claude-api', jobs: ['RQ-ENV-POOL'] },
        { lane: 'devin', jobs: ['RQ-ENV-LANE', 'RQ-PLAIN'] },
      ]);
      expect(JSON.stringify(result)).not.toContain('prompts/');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('counts spec-less rows the market rejects as malformed, never supply', async () => {
    const dir = await queueWithFiles([
      'RQ-BADENV\tphantom\tcodex\twork\tprompts/b1.md',
      'RQ-BADLANE\tphantom\tNOT_A_LANE\twork\tprompts/b2.md',
      'RQ-ENVBADLANE\tphantom\tNOT_A_LANE\twork\tprompts/b4.md',
      'RQ-BADSPEC\tphantom\tdevin\twork\tprompts/b3.md',
      'RQ-OK\tphantom\tcodex-local\tmid\tprompts/ok.md',
    ].join('\n'), [
      '- READY RQ-BADENV (P1, exclusive=maybe): malformed envelope',
      '- READY RQ-ENVBADLANE (P1, pool=claude): the envelope replaces the spec, so the lane cell is never read',
      '- READY RQ-BADSPEC (P1, preferred_lane=Not_A_Lane): bad hint',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      // exclusive=maybe fails from_envelope, a bare NOT_A_LANE lane cell fails
      // the requirements fallback (no envelope matched), and
      // preferred_lane=Not_A_Lane fails requirements — all invalid_requirements.
      // RQ-ENVBADLANE's envelope supplies the spec wholesale, so its bad lane
      // cell cannot reject it: it counts as claude supply like the dispatcher.
      expect(result).toMatchObject({
        total: 2, ready: 2, parked: 0, malformed: 3, unhinted: 0,
        sources: { ready: 'degraded' },
      });
      expect(result.byLane).toEqual([
        { lane: 'claude', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
        { lane: 'codex-local', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps lane-column parked rows on their lowercase lane', async () => {
    const dir = await queueWith([
      'RQ-PARK-COL\tphantom\tPARKED-DEP.codex\twork\tprompts/p.md',
      'RQ-LANED\tphantom\tdevin\twork\tprompts/n.md',
    ].join('\n'));
    try {
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result).toMatchObject({ total: 2, ready: 1, parked: 1, malformed: 0, unhinted: 0 });
      expect(result.byLane).toEqual([
        { lane: 'codex', ready: 0, parked: 1, phantom: 0, other: 0, otherRepos: [] },
        { lane: 'devin', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
      ]);
      expect(result.groups).toEqual([{ reason: 'DEP', lane: 'codex', count: 1, jobs: ['RQ-PARK-COL'] }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
