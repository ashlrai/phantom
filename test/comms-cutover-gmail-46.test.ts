import { describe, expect, it } from 'vitest';
import { buildCommsCutoverReadiness, type CommsCutoverReadinessDeps } from '../src/core/comms/cutover-readiness.js';
import { GMAIL_TRIAGE_LATEST_SCHEMA, type GmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';
import { GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, type GmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

const now = Date.parse('2026-11-09T12:00:00Z');
const triage = (at = '2026-11-09T11:00:00Z'): GmailTriageLatest => ({
  schema: GMAIL_TRIAGE_LATEST_SCHEMA, at, dir: 'inbox-a', scanned: 0, updates: 0, drafted: 0,
  review: 0, failed: 0, unreadInSample: 0, target: 100, archiveCandidateCount: 0,
});
const plans = (unread = 100, at = '2026-11-09T11:00:00Z'): GmailArchivePlanLatest => ({
  schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA,
  plans: [{ inbox: 'inbox-a', at, unread, target: 100, archiveCount: 0, topSenders: [] },
    { inbox: 'inbox-b', at, unread: 20, target: 100, archiveCount: 0, topSenders: [] }],
});
const report = (deps: CommsCutoverReadinessDeps = {}) => buildCommsCutoverReadiness({
  runsDir: '/nonexistent', diagnoseEmail: async () => { throw new Error(); },
  checkIMessage: () => { throw new Error(); }, readGmailTriage: () => null,
  readGmailPlans: () => null, now: () => now, ...deps,
});

describe('Gmail cutover evidence', () => {
  it('reports missing evidence and reader failures', async () => {
    for (const deps of [{}, { readGmailTriage: () => { throw new Error('inbox-a'); } },
      { readGmailTriage: () => triage(), readGmailPlans: () => { throw new Error(); } }]) {
      expect((await report(deps)).capabilities.gmailInboxTriage).toEqual({
        state: 'unverified', reason: 'gmail-triage-evidence-missing', nextStep: 'phm fleet gmail-triage',
      });
    }
  });

  it('blocks an over-target inbox even if evidence is old', async () => {
    expect((await report({ readGmailPlans: () => plans(101, '2020-01-01') })).capabilities.gmailInboxTriage)
      .toEqual({ state: 'blocked', reason: 'gmail-inbox-over-target', nextStep: 'phm fleet gmail-archive-plan' });
  });

  it('rejects stale, invalid and future evidence', async () => {
    for (const at of ['2026-11-08T11:59:59Z', 'invalid', '2026-11-09T12:00:01Z']) {
      expect((await report({ readGmailPlans: () => plans(100, at) })).capabilities.gmailInboxTriage)
        .toEqual({ state: 'unverified', reason: 'gmail-triage-evidence-stale', nextStep: 'phm fleet gmail-triage' });
    }
  });

  it('reports a fresh plan within target without exposing inboxes', async () => {
    const result = await report({ readGmailTriage: () => triage('2020-01-01'), readGmailPlans: () => plans() });
    expect(result.capabilities.gmailInboxTriage)
      .toEqual({ state: 'ready', reason: 'gmail-inboxes-within-target', nextStep: 'phm fleet gmail-archive-plan' });
    expect(JSON.stringify(result)).not.toContain('inbox-a');
    expect(JSON.stringify(result)).not.toContain('inbox-b');
    expect(result.overall.commsbotRetirement).toBe('not-evidenced');
  });

  it('requires a plan to evidence unread counts', async () => {
    expect((await report({ readGmailTriage: () => triage() })).capabilities.gmailInboxTriage)
      .toEqual({ state: 'unverified', reason: 'gmail-unread-not-evidenced', nextStep: 'phm fleet gmail-archive-plan' });
  });
});
