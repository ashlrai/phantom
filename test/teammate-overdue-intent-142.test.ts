/**
 * RQ-PHX-TEAMOVERDUEINTENT142: the overdue teammate sweep must not raise an
 * owner-thread "no reply yet" notice for texts the inbox classifier marks
 * `ignore` (acknowledgements, numbered patch artifacts). Reply and leader
 * intents stay eligible; ordering, threshold and durable dedupe are unchanged.
 *
 * Hermetic: runsDir is a tmp dir, handles are placeholders, nothing is sent.
 */

import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readTeammateTexts, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { findOverdueTeammateTexts, noticeOverdueTeammateTexts } from '../src/core/comms/teammate-overdue.js';
import { readOwnerThread } from '../src/core/comms/owner-thread.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';

const NOW_MS = Date.parse('2026-11-11T12:00:00Z');
const SEEN_PATH = () => join(root, 'queue', 'teammate-overdue-seen.json');
const threadTexts = () => readOwnerThread({ runsDir: root, settings: emptyOwnerSettings() }).messages.map(m => m.text);

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'teammate-overdue-intent-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Old ignore intents, old reply/leader intents and one fresh question, recorded out of order. */
function recordFixtureTexts(): void {
  const at = (minutes: number) => new Date(NOW_MS - minutes * 60_000);
  recordTeammateText({ rowid: 1, handle: 'fixture', text: 'thanks' }, root, at(12));
  recordTeammateText({ rowid: 2, handle: 'fixture', text: 'patch 1/3 fixture hunk? can you confirm?' }, root, at(11));
  recordTeammateText({ rowid: 5, handle: 'fixture', text: 'Can you check the fixture?' }, root, at(2));
  recordTeammateText({ rowid: 3, handle: 'fixture', text: 'Can you review the fixture draft?' }, root, at(8));
  recordTeammateText({ rowid: 4, handle: 'fixture', text: 'Mason, please approve the fixture release' }, root, at(10));
}

it('selects only reply and leader intents, oldest first, honoring the threshold', () => {
  recordFixtureTexts();
  const pending = readTeammateTexts({ runsDir: root, now: () => NOW_MS }).texts;
  expect(findOverdueTeammateTexts(pending, { now: NOW_MS }).map(t => t.rowid)).toEqual([4, 3]);
  expect(findOverdueTeammateTexts(pending, { now: NOW_MS, thresholdMs: 60_000 }).map(t => t.rowid)).toEqual([4, 3, 5]);
});

it('apply raises only actionable notices once and a dry run writes nothing', async () => {
  recordFixtureTexts();
  const opts = { runsDir: root, now: () => NOW_MS };

  expect(await noticeOverdueTeammateTexts({ ...opts, apply: false })).toEqual({ state: 'ok', raised: 0, skipped: 2 });
  expect(existsSync(SEEN_PATH())).toBe(false);
  expect(threadTexts()).toEqual([]);

  expect(await noticeOverdueTeammateTexts({ ...opts, apply: true })).toEqual({ state: 'ok', raised: 2, skipped: 0 });
  const texts = threadTexts();
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain('Mason, please approve the fixture release');
  expect(texts[1]).toContain('Can you review the fixture draft?');

  expect(await noticeOverdueTeammateTexts({ ...opts, apply: true })).toEqual({ state: 'ok', raised: 0, skipped: 2 });
  expect(threadTexts()).toHaveLength(2);

  // The observer never marks ignored texts answered; every fixture row stays pending.
  expect(readTeammateTexts({ runsDir: root, now: () => NOW_MS }).texts.map(t => t.rowid)).toEqual([1, 2, 4, 3, 5]);
});

it('keeps unavailable behavior on a degraded inbox', async () => {
  recordTeammateText({ rowid: 1, handle: 'fixture', text: 'Can you check the fixture?' }, root, new Date(NOW_MS - 600_000));
  appendFileSync(join(root, 'imessage', 'teammates.jsonl'), '{not json\n');
  expect(await noticeOverdueTeammateTexts({ runsDir: root, now: () => NOW_MS, apply: true }))
    .toEqual({ state: 'unavailable', raised: 0, skipped: 0 });
  expect(threadTexts()).toEqual([]);
});
