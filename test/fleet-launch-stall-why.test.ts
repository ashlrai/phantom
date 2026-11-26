import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainLaunchStall, readLaunchStallFacts, type LaunchStallFacts } from '../src/core/fleet/launch-stall-why.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const base: LaunchStallFacts = { lane: 'fake', running: 0, target: 4, queued: 5, held: false, usageFrac: 0.2, headLines: [{ id: 'RQ-FAKE-0001' }], lastLaunchAt: '2026-11-17T10:00:00Z' };

describe('explainLaunchStall', () => {
  it('explains a held lane', () => {
    const v = explainLaunchStall({ ...base, held: true, heldReason: 'usage_limit', usageResetAt: '2026-11-17T20:00:00Z' }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.reasons[0]).toBe('held: usage_limit');
    expect(v.firstAction).toBe('lane held: usage_limit until 2026-11-17T20:00:00Z; nothing to do before then');
  });
  it('explains an exhausted lane with its reset', () => {
    const v = explainLaunchStall({ ...base, usageFrac: 1, usageResetAt: '2026-11-17T20:00:00Z' }, NOW);
    expect(v.reasons[0]).toContain('usage exhausted: 100% used, resets 2026-11-17T20:00:00Z');
  });
  it('lists the first three blocked head lines', () => {
    const heads = ['A', 'B', 'C', 'D'].map(x => ({ id: `RQ-FAKE-000${x}`, blockedBy: 'RQ-FAKE-9999' }));
    const v = explainLaunchStall({ ...base, headLines: heads }, NOW);
    expect(v.reasons[0]).toContain('all 4 head lines blocked: RQ-FAKE-000A (RQ-FAKE-9999), RQ-FAKE-000B');
    expect(v.reasons[0]).not.toContain('RQ-FAKE-000D');
    expect(v.firstAction).toContain('RQ-FAKE-9999');
  });
  it('does not flag a healthy lane that launched recently', () => {
    const v = explainLaunchStall({ ...base, running: 2, lastLaunchAt: '2026-11-17T11:50:00Z' }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.reasons).toEqual([]);
  });
  it('is stalled with no unusual fact but an old launch', () => {
    const v = explainLaunchStall(base, NOW);
    expect(v.stalled).toBe(true);
    expect(v.reasons[0]).toBe('no launch since 2026-11-17T10:00:00Z (120 min ago)');
  });
  it('reports missing facts as unknown', () => {
    const v = explainLaunchStall({ lane: 'fake', running: 0, target: 4, queued: 5, held: false, headLines: [] }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.reasons.at(-1)).toBe('unknown (not assumed fine): usage, head lines, last launch');
    const none = explainLaunchStall({ lane: 'fake', held: false, headLines: [] }, NOW);
    expect(none.stalled).toBe(false);
    expect(none.reasons[0]).toContain('running, target, queued');
  });
});

describe('readLaunchStallFacts', () => {
  it('builds facts from the fixture runs dir', async () => {
    const facts = await readLaunchStallFacts(join(import.meta.dirname, 'fixtures', 'launch-stall'));
    const by = Object.fromEntries(facts.map(f => [f.lane, f]));
    expect(by['fake-held']).toMatchObject({ held: true, heldReason: 'usage_limit', usageFrac: 1.02, usageResetAt: '2026-11-17T20:00:00.000Z', queued: 3 });
    expect(by['fake-open']).toMatchObject({ running: 1, lastLaunchAt: '2026-11-17T09:00:00.000Z', lastMergeAt: '2026-11-17T10:00:00.000Z' });
    expect(by['fake-open']!.headLines).toEqual([{ id: 'RQ-FAKE-0001', blockedBy: 'blocked' }, { id: 'RQ-FAKE-0002' }]);
    expect(by['fake-bare']).toMatchObject({ running: undefined, usageFrac: undefined, headLines: [] });
  });
  it('reads head lines from launchable rows, skipping parked ones', async () => {
    const facts = await readLaunchStallFacts(join(import.meta.dirname, 'fixtures', 'launch-stall-parked'));
    const by = Object.fromEntries(facts.map(f => [f.lane, f]));
    // Parked rows wait on dependencies or holds; dispatchd skips them, so the
    // launch head is the first non-parked rows in queue order.
    expect(by['claude']!.headLines).toEqual([{ id: 'RQ-HEAD-1' }, { id: 'RQ-HEAD-2' }, { id: 'RQ-HEAD-3' }]);
    expect(by['codex-work']!.headLines).toEqual([{ id: 'RQ-HEAD-5' }]);
    const verdict = explainLaunchStall(by['claude']!, NOW);
    expect(verdict.stalled).toBe(true);
    expect(verdict.reasons.join(' ')).not.toContain('head lines blocked');
  });
  it('attributes spec-less head lines through their router-queue envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-stall-envelope-'));
    try {
      mkdirSync(join(dir, 'queue'));
      writeFileSync(join(dir, 'queue', 'status.json'),
        '{"lanes":{"claude":{"running":0,"target":4,"queued":2,"held":false},"codex-local":{"running":0,"target":4,"queued":1,"held":false}}}');
      writeFileSync(join(dir, 'queue', 'ready.tsv'),
        'RQ-ENV-A\tphantom\tcodex-local\twork\t/abs/a.md\nRQ-COL-B\tphantom\tcodex-local\twork\t/abs/b.md\n');
      writeFileSync(join(dir, 'queue', 'router-queue.md'),
        '- READY phantom RQ-ENV-A (preferred_lane=claude): hinted work\n');
      const facts = await readLaunchStallFacts(dir);
      const by = Object.fromEntries(facts.map(f => [f.lane, f]));
      // RQ-ENV-A's lane column says codex-local, but its envelope names claude —
      // the lane the market would route it to, so it heads claude's queue.
      expect(by['claude']!.headLines).toEqual([{ id: 'RQ-ENV-A' }]);
      expect(by['codex-local']!.headLines).toEqual([{ id: 'RQ-COL-B' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('resolves envelopes when router-queue.md outgrows the old read bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-stall-deep-'));
    try {
      mkdirSync(join(dir, 'queue'));
      writeFileSync(join(dir, 'queue', 'status.json'),
        '{"lanes":{"claude":{"running":0,"target":4,"queued":1,"held":false},"codex-local":{"running":0,"target":4,"queued":0,"held":false}}}');
      writeFileSync(join(dir, 'queue', 'ready.tsv'), 'RQ-ENV-DEEP\tphantom\tcodex-local\twork\t/abs/deep.md\n');
      // router-queue.md is append-mostly history; past the old 8 MiB window
      // the market still resolves the envelope, so this reader must too.
      const pad = `# ${'y'.repeat(1024)}\n`.repeat(8400);
      writeFileSync(join(dir, 'queue', 'router-queue.md'), pad +
        '- READY phantom RQ-ENV-DEEP (preferred_lane=claude): hinted work\n');
      const facts = await readLaunchStallFacts(dir);
      const by = Object.fromEntries(facts.map(f => [f.lane, f]));
      expect(by['claude']!.headLines).toEqual([{ id: 'RQ-ENV-DEEP' }]);
      expect(by['codex-local']!.headLines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns no lanes for an empty runs dir', async () => {
    expect(await readLaunchStallFacts(join(import.meta.dirname, 'fixtures', 'launch-stall', 'nope'))).toEqual([]);
  });
});
