import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildGmailStatusReport, cmdFleetGmailStatus } from '../src/cli/fleet-gmail-status.js';
import { gmailArchivePlanLatestPath, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';
import { writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

const dirs: string[] = [];
const scopeA = { source: 'local-eml-export' as const, scanned: 5, files: 20, limit: 5, truncated: true, unreadRepresentsLiveTotal: false as const };
const scopeB = { source: 'local-eml-export' as const, scanned: 3, files: 3, limit: 10, truncated: false, unreadRepresentsLiveTotal: false as const };
const triageScope = { source: 'local-eml-export' as const, files: 20, limit: 5, truncated: true };
function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archive-scope-'));
  dirs.push(dir);
  writeGmailTriageLatest(dir, { dir: '/private/triage', scanned: 5, updates: 1, drafted: 0, review: 0,
    failed: 0, unreadInSample: 4, target: 2, archiveCandidateCount: 2, scope: triageScope });
  return dir;
}
async function output(dir: string, json = false): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetGmailStatus(['--runs-dir', dir, ...(json ? ['--json'] : [])])).toBe(0);
    return log.mock.calls.map(call => call.join(' ')).join('\n');
  } finally { log.mockRestore(); }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('preserves validated scope for each saved plan in reports and both CLI formats', async () => {
  const dir = setup();
  for (const [inbox, scope] of [['alpha', scopeA], ['beta', scopeB]] as const) {
    writeGmailArchivePlanLatest(dir, { inbox: `/private/${inbox}`, unread: 3, target: 2, archiveCount: 1,
      topSenders: [{ sender: 'private-sender@example.test', count: 1 }], scope });
  }
  const path = gmailArchivePlanLatestPath(dir);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.plans[0].scope.extra = 'private-content';
  writeFileSync(path, JSON.stringify(raw));
  const report = buildGmailStatusReport(dir);
  expect(report.archivePlans.plans.map(p => [p.inbox, p.scope])).toEqual([['alpha', scopeA], ['beta', scopeB]]);
  expect(report.triage.scope).toEqual(triageScope);
  expect(report.triageInboxes[0]).toMatchObject({ label: 'triage', scope: triageScope, counts: { scanned: 5 } });
  expect(report).toMatchObject({ schema: 'fleet.gmail-status.v1', countsDescribe: 'saved-export-samples',
    liveInbox: 'unknown', archiveExecution: 'unverified' });
  const json = await output(dir, true);
  expect(JSON.parse(json).archivePlans.plans.map((p: { scope: unknown }) => p.scope)).toEqual([scopeA, scopeB]);
  const text = await output(dir);
  expect(text).toContain('scanned 5; scan limit 5; saved files 20; truncated true; unread is not a live total');
  expect(text).toContain('scanned 3; scan limit 10; saved files 3; truncated false; unread is not a live total');
  for (const value of ['/private', 'private-sender', 'private-content', 'topSenders']) expect(json + text).not.toContain(value);
});

it('reports legacy scope as unknown and missing archive independently of triage', async () => {
  const dir = setup();
  writeGmailArchivePlanLatest(dir, { inbox: 'legacy', unread: 2, target: 1, archiveCount: 1, topSenders: [] });
  expect(buildGmailStatusReport(dir).archivePlans.plans[0]).not.toHaveProperty('scope');
  expect(JSON.parse(await output(dir, true)).archivePlans.plans[0]).not.toHaveProperty('scope');
  expect(await output(dir)).toContain('archive count 1; scope unknown');
  rmSync(gmailArchivePlanLatestPath(dir));
  const report = buildGmailStatusReport(dir);
  expect(report.archivePlans).toEqual({ state: 'missing', planCount: 0, plans: [] });
  expect(report.triage.scope).toEqual(triageScope);
  expect(JSON.parse(await output(dir, true)).triageInboxes[0].scope).toEqual(triageScope);
  expect(await output(dir)).toContain('Archive plans: missing');
});
