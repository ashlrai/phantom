import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gmailTriageLatestPath, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';
import { readFleetGmailTriageLatest } from '../src/mcp/fleet-gmail-triage-latest.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'triage-sample-truth-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function save(unreadInSample: number, target: number): void {
  writeGmailTriageLatest(root, {
    dir: '/synthetic/Inbox', scanned: 100, updates: 0, drafted: 0, review: 0, failed: 0,
    unreadInSample, target, archiveCandidateCount: 0, now: () => new Date('2026-11-10T12:00:00Z'),
  });
}

describe('saved Gmail sample truth', () => {
  it.each([[100, 100, false], [20, 100, false], [100, 50, true]])(
    'limits %i unread against target %i to the sample', (unread, target, expected) => {
      save(unread, target);
      const report = readFleetGmailTriageLatest(root, () => new Date('2026-11-10T11:59:59Z'));
      expect(report).toMatchObject({ state: 'present', overTarget: expected, overTargetScope: 'sample', liveInboxTargetState: 'unknown', ageSeconds: 0 });
      expect(report.latest).toMatchObject({ unreadInSample: unread, target });
      expect(JSON.stringify(report)).not.toMatch(/subject|sender|message.?id|body|\/synthetic|triage-sample-truth/i);
    },
  );

  it('keeps absent and invalid evidence unknown', () => {
    const check = () => expect(readFleetGmailTriageLatest(root)).toMatchObject({
      state: 'missing', latest: null, overTarget: null, overTargetScope: 'unknown', liveInboxTargetState: 'unknown', ageSeconds: null,
    });
    check();
    const path = gmailTriageLatestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    for (const invalid of ['{', JSON.stringify({ schema: 'invalid' })]) {
      writeFileSync(path, invalid);
      check();
    }
  });
});
