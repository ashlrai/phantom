import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommsCutoverReadiness, type CommsCutoverReport } from '../src/core/comms/cutover-readiness.js';
import {
  GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, writeGmailArchivePlanLatest,
  type GmailArchivePlanScope,
} from '../src/core/comms/gmail-archive-plan-latest.js';
import { writeGmailTriageLatest, type GmailTriageScope } from '../src/core/comms/gmail-triage-latest.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let root: string, runsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-provenance-'));
  runsDir = join(root, 'runs');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const planScope = (over: Partial<GmailArchivePlanScope> = {}): GmailArchivePlanScope => ({
  source: 'local-eml-export', scanned: 10, files: 10, limit: 100, truncated: false,
  unreadRepresentsLiveTotal: false, ...over,
});
const triageScope = (over: Partial<GmailTriageScope> = {}): GmailTriageScope => ({
  source: 'local-eml-export', files: 10, limit: 100, truncated: false, ...over,
});

interface PlanOpts { atMs?: number; scope?: GmailArchivePlanScope | null }
const writePlan = (inbox: string, unread: number, target: number, opts: PlanOpts = {}) =>
  writeGmailArchivePlanLatest(runsDir, {
    inbox, unread, target, archiveCount: 0,
    topSenders: [{ sender: 'sender-one@example.test', count: 3 }],
    ...(opts.scope === null ? {} : { scope: opts.scope ?? planScope() }),
    now: () => new Date(opts.atMs ?? NOW),
  });
const writeTriage = (dir: string, atMs = NOW, scope: GmailTriageScope | null = triageScope()) =>
  writeGmailTriageLatest(runsDir, {
    dir, scanned: 10, updates: 0, drafted: 0, review: 0, failed: 0,
    unreadInSample: 5, target: 100, archiveCandidateCount: 0,
    ...(scope === null ? {} : { scope }),
    now: () => new Date(atMs),
  });

const report = () => buildCommsCutoverReadiness({
  runsDir,
  diagnoseEmail: async () => { throw new Error('no email evidence in this fixture'); },
  checkIMessage: () => { throw new Error('no imessage evidence in this fixture'); },
  now: () => NOW,
});
const gmail = async () => (await report()).capabilities.gmailInboxTriage;

const expectNoLeaks = (r: CommsCutoverReport) => {
  const out = JSON.stringify(r);
  for (const marker of ['alpha-inbox', 'beta-inbox', 'gamma-inbox', 'fake-export-alpha',
    'sender-one@example.test', root]) expect(out).not.toContain(marker);
};

describe('gmail cutover provenance', () => {
  it('reports unverified for a fresh under-target export sample, never ready', async () => {
    // Regression: this fixture previously produced state 'ready' with reason
    // 'gmail-inboxes-within-target' even though every count is a local .eml
    // export sample (unreadRepresentsLiveTotal is always false).
    writePlan('alpha-inbox', 5, 100);
    writeTriage('/tmp/fake-export-alpha');
    const r = await report();
    expect(r.capabilities.gmailInboxTriage).toEqual({
      state: 'unverified', reason: 'gmail-inbox-live-total-unverified',
      nextStep: 'phm fleet gmail-archive-plan',
    });
    expect(r.overall.state).toBe('incomplete');
    expect(r.overall.commsbotRetirement).toBe('not-evidenced');
    expectNoLeaks(r);
  });

  it('does not let a fresh inbox freshen a stale sibling', async () => {
    writePlan('alpha-inbox', 5, 100, { atMs: NOW });
    writePlan('beta-inbox', 7, 100, { atMs: NOW - DAY - HOUR });
    expect(await gmail()).toEqual({
      state: 'unverified', reason: 'gmail-triage-evidence-partial',
      nextStep: 'phm fleet gmail-triage',
    });
  });

  it('treats records without scope provenance as unknown, not live totals', async () => {
    writePlan('alpha-inbox', 5, 100, { scope: null });
    expect(await gmail()).toEqual({
      state: 'unverified', reason: 'gmail-inbox-scope-unknown',
      nextStep: 'phm fleet gmail-archive-plan',
    });
  });

  it('treats a truncated export as insufficient evidence of live totals', async () => {
    writePlan('alpha-inbox', 5, 100, {
      scope: planScope({ scanned: 50, files: 200, limit: 50, truncated: true }),
    });
    expect(await gmail()).toEqual({
      state: 'unverified', reason: 'gmail-inbox-export-truncated',
      nextStep: 'phm fleet gmail-archive-plan',
    });
  });

  it('rejects future-dated and invalid timestamps as stale evidence', async () => {
    writePlan('alpha-inbox', 5, 100, { atMs: NOW + HOUR });
    expect(await gmail()).toEqual({
      state: 'unverified', reason: 'gmail-triage-evidence-stale',
      nextStep: 'phm fleet gmail-triage',
    });

    const path = join(runsDir, 'comms', 'gmail-archive-plan-latest.json');
    writeFileSync(path, `${JSON.stringify({
      schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA,
      plans: [{ inbox: 'gamma-inbox', at: 'not-a-timestamp', unread: 1, target: 100,
        archiveCount: 0, topSenders: [] }],
    })}\n`);
    expect(await gmail()).toEqual({
      state: 'unverified', reason: 'gmail-triage-evidence-stale',
      nextStep: 'phm fleet gmail-triage',
    });
  });

  it('reports missing evidence when no records exist', async () => {
    expect(await gmail()).toEqual({
      state: 'unverified', reason: 'gmail-triage-evidence-missing',
      nextStep: 'phm fleet gmail-triage',
    });
  });

  it('keeps an over-target sample a conservative blocker without claiming coverage', async () => {
    writePlan('alpha-inbox', 150, 100, { atMs: NOW });
    writePlan('beta-inbox', 20, 100, { atMs: NOW - 2 * DAY });
    expect(await gmail()).toEqual({
      state: 'blocked', reason: 'gmail-inbox-over-target',
      nextStep: 'phm fleet gmail-archive-plan',
    });
  });
});
