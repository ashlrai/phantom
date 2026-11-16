import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { markTeammateTextsAnswered, readTeammateTexts, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { findOverdueTeammateTexts, noticeOverdueTeammateTexts } from '../src/core/comms/teammate-overdue.js';
import { readOwnerThread } from '../src/core/comms/owner-thread.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'teammate-overdue-')); });
const now = Date.parse('2026-11-09T12:00:00Z');
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('filters answered and recent texts and sorts oldest first', () => {
  for (const [rowid, minutes] of [[1, 6], [2, 2], [3, 15], [4, 10]]) {
    recordTeammateText({ rowid: rowid!, handle: 'fixture', text: 'Please respond?' }, root, new Date(now - minutes! * 60_000));
  }
  markTeammateTextsAnswered([4], root);
  const pending = readTeammateTexts({ runsDir: root, now: () => now }).texts.reverse();
  expect(findOverdueTeammateTexts(pending, { now }).map(t => t.rowid)).toEqual([3, 1]);
});

it('raises each overdue text once across ticks in the private thread', async () => {
  recordTeammateText({ rowid: 11, handle: 'fixture', text: 'Please respond?' }, root, new Date(now - 600_000));
  const opts = { runsDir: root, now: () => now, apply: true };
  expect(await noticeOverdueTeammateTexts(opts)).toEqual({ state: 'ok', raised: 1, skipped: 0 });
  expect(await noticeOverdueTeammateTexts(opts)).toEqual({ state: 'ok', raised: 0, skipped: 1 });
  expect(readOwnerThread({ runsDir: root, settings: emptyOwnerSettings() }).messages.map(m => m.text)).toEqual(['Teammate texted 10 min ago, no reply yet: Please respond?']);
});

it('reports an unavailable inbox without raising', async () => {
  expect(await noticeOverdueTeammateTexts({ runsDir: root, apply: true })).toEqual({ state: 'unavailable', raised: 0, skipped: 0 });
});

it('isolates a throwing overdue step and continues', async () => {
  const ok = async () => ({ exitCode: 0, output: '{}' });
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(name => [name, ok])) as SelfTickSteps;
  const sweep = vi.fn(ok);
  steps['teammate-overdue'] = async () => { throw new Error('fixture'); };
  steps['landed-sweep'] = sweep;
  const { report } = await runSelfTick({ runsDir: root, steps });
  expect(report.steps.find(s => s.step === 'teammate-overdue')?.state).toBe('failed');
  expect(sweep).toHaveBeenCalledOnce();
});
