/**
 * RQ-PHX-GMAILARCHIVEMCPSCOPE120 — fleet_gmail_archive_plan_latest must mark
 * every saved plan as a sample comparison, never live inbox health. Hermetic:
 * plans are written through the real saved-record writer into a temp runs dir
 * and read back through the exported MCP reader; two fake inboxes only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gmailArchivePlanLatestPath, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';
import {
  parseFleetGmailArchivePlanLatestArgs, readFleetGmailArchivePlanLatest,
} from '../src/mcp/fleet-gmail-archive-plan-latest.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'archive-sample-truth-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const SAVED_AT = new Date('2026-11-10T12:00:00Z');
const READ_AT = new Date('2026-11-10T12:01:00Z'); // 60 s after the save

function save(inbox: string, unread: number, target = 100): void {
  writeGmailArchivePlanLatest(root, {
    inbox, unread, target, archiveCount: Math.max(0, unread - target),
    topSenders: [{ sender: 'news@example.test', count: 40 }], now: () => SAVED_AT,
  });
}

describe('saved Gmail archive plan sample truth', () => {
  it.each([[150, 100, true], [20, 100, false], [100, 100, false]])(
    'scopes the %i-vs-%i over-target flag to the saved sample, never the live inbox',
    (unread, target, over) => {
      save('work@example.test', unread, target);
      save('home@example.test', 20);
      const report = readFleetGmailArchivePlanLatest({}, root, () => READ_AT);
      expect(report).toMatchObject({ schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'present' });
      expect(report.plans).toHaveLength(2);
      expect(report.plans.find(p => p.inbox === 'work@example.test')).toMatchObject({
        unread, target, overTarget: over,
        overTargetScope: 'sample', liveInboxTargetState: 'unknown', ageSeconds: 60,
      });
      // The under-target inbox is equally unknown live: an in-target sample
      // proves neither a healthy inbox nor a completed archive.
      expect(report.plans.find(p => p.inbox === 'home@example.test')).toMatchObject({
        overTarget: false, overTargetScope: 'sample', liveInboxTargetState: 'unknown',
      });
      expect(JSON.stringify(report)).not.toContain(root);
    },
  );

  it('keeps the sample scope and unknown live state on inbox-filtered reads', () => {
    save('work@example.test', 150);
    save('home@example.test', 20);
    const one = readFleetGmailArchivePlanLatest({ inbox: 'home@example.test' }, root, () => READ_AT);
    expect(one.plans).toHaveLength(1);
    expect(one.plans[0]).toMatchObject({
      inbox: 'home@example.test', overTarget: false,
      overTargetScope: 'sample', liveInboxTargetState: 'unknown', ageSeconds: 60,
    });
    // A filter matching nothing is present-but-empty: no health is implied.
    expect(readFleetGmailArchivePlanLatest({ inbox: 'nobody@example.test' }, root))
      .toEqual({ schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'present', plans: [] });
  });

  it('keeps absent and invalid evidence unknown, never healthy', () => {
    const missing = { schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'missing', plans: [] };
    const check = () => expect(readFleetGmailArchivePlanLatest({}, root)).toEqual(missing);
    check();
    const path = gmailArchivePlanLatestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    for (const invalid of ['{', JSON.stringify({ schema: 'invalid', plans: [] })]) {
      writeFileSync(path, invalid);
      check();
    }
  });

  it('reports null freshness only when a saved timestamp is unparseable', () => {
    // The writer always emits ISO `at`; a corrupt timestamp needs a raw file
    // (same hermetic pattern as the sibling sample-truth suite).
    const path = gmailArchivePlanLatestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schema: 'fleet.gmail-archive-plan-latest.v1',
      plans: [
        { inbox: 'work@example.test', at: 'not-a-date', unread: 150, target: 100, archiveCount: 50, topSenders: [] },
        { inbox: 'home@example.test', at: '2026-11-10T12:00:00Z', unread: 20, target: 100, archiveCount: 0, topSenders: [] },
      ],
    }));
    const report = readFleetGmailArchivePlanLatest({}, root, () => READ_AT);
    expect(report.plans.find(p => p.inbox === 'work@example.test'))
      .toMatchObject({ overTarget: true, overTargetScope: 'sample', liveInboxTargetState: 'unknown', ageSeconds: null });
    expect(report.plans.find(p => p.inbox === 'home@example.test')).toMatchObject({ ageSeconds: 60 });
  });

  it('never writes back to the saved file and still rejects caller-supplied paths', () => {
    save('work@example.test', 150);
    save('home@example.test', 20);
    const path = gmailArchivePlanLatestPath(root);
    const before = readFileSync(path, 'utf8');
    readFleetGmailArchivePlanLatest({}, root);
    readFleetGmailArchivePlanLatest({ inbox: 'work@example.test' }, root);
    expect(readFileSync(path, 'utf8')).toBe(before);
    // No lock or temp leftovers: the reader leaves the comms dir as written.
    expect(readdirSync(dirname(path))).toEqual(['gmail-archive-plan-latest.json']);
    for (const key of ['dir', 'path', 'root', 'cwd']) {
      expect(parseFleetGmailArchivePlanLatestArgs({ [key]: '/tmp' })).toBeNull();
    }
  });
});
