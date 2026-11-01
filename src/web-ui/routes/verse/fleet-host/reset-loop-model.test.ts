import { describe, expect, it } from 'vitest';
import type { UsageResets, UsageResetRow } from '../shell/usage-resets-query.js';
import { releaseRows, resetLoopLine, unreleasedResets } from './reset-loop-model.js';
import { narrowResetReleases, type ResetReleases } from './reset-loop-query.js';

const now = Date.parse('2026-10-31T20:30:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const release = (lane = 'codex-personal', minutes = 28): ResetReleases['releases'][number] => ({
  v: 1, lane, state: 'reset-detected', usedPct: 0, readingAsOf: at(29), heldUntil: null, at: at(minutes), by: 'reset-detect', reason: 'reset',
});
const data: ResetReleases = { v: 1, generatedAt: at(0), loop: { started: true, lastRunAt: new Date(now - 40_000).toISOString(), lastResult: { at: at(0), checked: 1, released: [], errors: [] }, lastError: null }, releases: [release()] };
const resetRow: UsageResetRow = { lane: 'codex-personal', held: true, heldReason: 'usage', heldUntil: null, holdSince: at(60), heldBy: 'autobackoff', usedPct: 0, readingAsOf: at(25), resetAt: at(25), state: 'reset-detected', releasable: true, tell: '' };
const resets: UsageResets = { v: 1, generatedAt: at(0), sourceState: 'healthy', rows: [resetRow] };

describe('reset loop', () => {
  it('describes the armed loop, unarmed authorization, stale runs, and errors', () => {
    expect(resetLoopLine(data, now)).toEqual({ text: 'Reset loop armed · last run 40s ago · 0 released', tone: 'ok' });
    const unarmed = { ...data, loop: { ...data.loop, started: false } };
    expect(resetLoopLine(unarmed, now, true)).toEqual({ text: 'Reset loop not armed', tone: 'bad' });
    expect(resetLoopLine(unarmed, now, false).tone).toBe('warn');
    expect(resetLoopLine({ ...data, loop: { ...data.loop, lastRunAt: at(10) } }, now).tone).toBe('ok');
    expect(resetLoopLine({ ...data, loop: { ...data.loop, lastRunAt: at(11) } }, now).tone).toBe('warn');
    expect(resetLoopLine({ ...data, loop: { ...data.loop, lastRunAt: null } }, now).tone).toBe('warn');
    expect(resetLoopLine({ ...data, loop: { ...data.loop, lastError: 'failed' } }, now).tone).toBe('bad');
  });
  it('shows the newest five releases with their state and usage', () => {
    const releases = Array.from({ length: 6 }, (_, i) => release(`lane-${i}`, i));
    releases[0] = { ...releases[0]!, state: 'hold-expired', usedPct: null };
    const rows = releaseRows({ ...data, releases: releases.reverse() }, now);
    const time = new Date(at(0)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe(`lane-0 released ${time} (hold expired, unknown used)`);
    expect(rows[1]).toContain('lane-1 released');
    expect(rows[1]).toContain('(reset detected, 0% used)');
  });
  it('flags only overdue newest detections without a subsequent release', () => {
    expect(unreleasedResets(resets, data, now)).toEqual([{ lane: 'codex-personal', sinceText: '25 min ago' }]);
    expect(unreleasedResets(resets, { ...data, releases: [release('codex-personal', 24)] }, now)).toEqual([]);
    expect(unreleasedResets(resets, { ...data, releases: [release('codex-personal', 25)] }, now)).toHaveLength(1);
    expect(unreleasedResets({ ...resets, rows: [{ ...resetRow, readingAsOf: at(10) }] }, data, now)).toEqual([]);
    expect(unreleasedResets({ ...resets, rows: [resetRow, { ...resetRow, state: 'open', readingAsOf: at(5) }] }, data, now)).toEqual([]);
    expect(unreleasedResets(resets, null, now)).toEqual([]);
  });
  it('rejects malformed response shapes', () => {
    expect(narrowResetReleases(data)).toEqual(data);
    expect(narrowResetReleases({ ...data, loop: { ...data.loop, lastResult: { ...data.loop.lastResult, errors: [{ lane: 1 }] } } })).toBeNull();
    expect(narrowResetReleases({ ...data, releases: [{ ...release(), usedPct: '0' }] })).toBeNull();
    expect(narrowResetReleases({ ...data, loop: { ...data.loop, started: 'yes' } })).toBeNull();
    expect(narrowResetReleases(null)).toBeNull();
  });
});
