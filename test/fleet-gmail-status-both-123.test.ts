import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailStatus } from '../src/cli/fleet-gmail-status.js';
import { gmailTriageLatestPath, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';
import { writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

const dirs: string[] = [];
const counts = { scanned: 10, updates: 2, drafted: 1, review: 3, failed: 0, unreadInSample: 4, target: 5, archiveCandidateCount: 6 };
const now = () => Date.parse('2026-01-01T00:00:00Z');
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-status-'));
  dirs.push(dir);
  return dir;
}
async function run(dir: string, json = false): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetGmailStatus(['--runs-dir', dir, ...(json ? ['--json'] : [])], { now })).toBe(0);
    return log.mock.calls.map(call => call.join(' ')).join('\n');
  } finally { log.mockRestore(); }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Gmail status per-label evidence', () => {
  it('prints both saved labels and retains the latest compatibility record', async () => {
    const dir = store();
    writeGmailTriageLatest(dir, { ...counts, dir: '/private/zeta', now: () => new Date('2025-12-31T23:59:00Z') });
    writeGmailTriageLatest(dir, { ...counts, scanned: 20, dir: '/private/alpha', now: () => new Date('2026-01-01T00:01:00Z') });
    const json = await run(dir, true);
    const report = JSON.parse(json);
    expect(report.triage.label).toBe('alpha');
    expect(report.triage.counts.scanned).toBe(20);
    expect(report.triageInboxes.map((entry: { label: string }) => entry.label)).toEqual(['alpha', 'zeta']);
    expect(report.triageInboxes[0].ageSeconds).toBe(-60);
    expect(report.triageInboxes[1].counts).toEqual(counts);
    expect(json).not.toContain('/private');
    const text = await run(dir);
    expect(text).toContain('"alpha"');
    expect(text).toContain('"zeta"');
    expect(text).toContain('clock skew');
    expect(text).toContain('live inbox state unknown');
    expect(text).toContain('archive execution unverified');
    expect(text).not.toContain('/private');
  });
  it('projects legacy v1 records', async () => {
    const dir = store();
    writeGmailTriageLatest(dir, { ...counts, dir: 'legacy' });
    const path = gmailTriageLatestPath(dir);
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(envelope.latest));
    const report = JSON.parse(await run(dir, true));
    expect(report.triageInboxes).toEqual([report.triage]);
    expect(await run(dir)).toContain('"legacy"');
  });
  it.each(['missing', 'corrupt'])('keeps archive plans when triage is %s', async state => {
    const dir = store();
    writeGmailArchivePlanLatest(dir, { inbox: 'archive', unread: 7, target: 3, archiveCount: 4, topSenders: [{ sender: 'secret@example.test', count: 1 }] });
    if (state === 'corrupt') writeFileSync(gmailTriageLatestPath(dir), '{');
    const json = await run(dir, true);
    const report = JSON.parse(json);
    expect(report.triage.state).toBe('missing');
    expect(report.triageInboxes).toEqual([]);
    expect(report.archivePlans.plans[0].archiveCount).toBe(4);
    expect(json).not.toContain('secret@example.test');
    expect(await run(dir)).toContain('archive count 4');
  });
});
