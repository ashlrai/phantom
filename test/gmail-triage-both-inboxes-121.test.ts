import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GMAIL_TRIAGE_LATEST_SCHEMA, GMAIL_TRIAGE_STORE_SCHEMA, gmailTriageLatestPath,
  readGmailTriageInboxReports, readGmailTriageLatest, writeGmailTriageLatest,
} from '../src/core/comms/gmail-triage-latest.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { createGmailTriageApi, VERSE_GMAIL_TRIAGE_PATH } from '../src/core/verse/gmail-triage-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'gmail-both-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

const counts = { scanned: 2, updates: 1, drafted: 0, review: 1, failed: 0, unreadInSample: 2, target: 100, archiveCandidateCount: 0 };
const save = (dir: string, overrides: Record<string, unknown> = {}) =>
  writeGmailTriageLatest(runsDir, { dir, ...counts, ...overrides } as Parameters<typeof writeGmailTriageLatest>[1]);

async function call(method = 'GET', allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: VERSE_GMAIL_TRIAGE_PATH, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await createGmailTriageApi({ runsDir })({ cfg: {}, allowDispatch } as VerseApiContext, req, res, VERSE_GMAIL_TRIAGE_PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('per-inbox gmail triage reports', () => {
  it('keeps one count-only report per directory label and preserves the others on update', () => {
    save('/accounts/alpha');
    save('/accounts/beta');
    let reports = readGmailTriageInboxReports(runsDir);
    expect(reports?.schema).toBe(GMAIL_TRIAGE_STORE_SCHEMA);
    expect(reports?.inboxes.map(r => r.dir).sort()).toEqual(['alpha', 'beta']);
    expect(reports?.latest).toMatchObject({ dir: 'beta', scanned: 2 });
    expect(readGmailTriageLatest(runsDir)).toMatchObject({ dir: 'beta' });

    save('/accounts/alpha', { scanned: 5, unreadInSample: 5 });
    reports = readGmailTriageInboxReports(runsDir);
    expect(reports?.inboxes.find(r => r.dir === 'alpha')).toMatchObject({ scanned: 5, unreadInSample: 5 });
    expect(reports?.inboxes.find(r => r.dir === 'beta')).toMatchObject({ scanned: 2, unreadInSample: 2 });
    expect(reports?.latest).toMatchObject({ dir: 'alpha', scanned: 5 });
    expect(readGmailTriageLatest(runsDir)).toMatchObject({ dir: 'alpha', scanned: 5 });
  });

  it('loads a legacy single-report file and migrates it on the next write', () => {
    const legacy = { schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: '2026-11-09T10:00:00.000Z', dir: 'old', ...counts };
    mkdirSync(dirname(gmailTriageLatestPath(runsDir)), { recursive: true });
    writeFileSync(gmailTriageLatestPath(runsDir), `${JSON.stringify(legacy)}\n`);
    expect(readGmailTriageLatest(runsDir)).toEqual(legacy);
    expect(readGmailTriageInboxReports(runsDir)?.inboxes).toHaveLength(1);
    expect(readGmailTriageInboxReports(runsDir)?.inboxes[0]).toMatchObject({ dir: 'old' });

    save('/accounts/new');
    const dirs = readGmailTriageInboxReports(runsDir)?.inboxes.map(r => r.dir).sort();
    expect(dirs).toEqual(['new', 'old']);
    expect(readGmailTriageLatest(runsDir)).toMatchObject({ dir: 'new' });
  });

  it('enforces inbox and file bounds and stays unknown on invalid storage', () => {
    for (let i = 0; i < 10; i++) save(`/accounts/inbox-${i}`, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    const reports = readGmailTriageInboxReports(runsDir);
    expect(reports?.inboxes).toHaveLength(8);
    const dirs = reports?.inboxes.map(r => r.dir) ?? [];
    expect(dirs).not.toContain('inbox-0');
    expect(dirs).toContain('inbox-9');

    const path = gmailTriageLatestPath(runsDir);
    for (const text of ['not json', JSON.stringify({ schema: 'other.v2', latest: null, inboxes: {} }),
      JSON.stringify({ schema: GMAIL_TRIAGE_STORE_SCHEMA, latest: null, inboxes: {}, pad: 'x'.repeat(70_000) })]) {
      writeFileSync(path, text);
      expect(readGmailTriageInboxReports(runsDir)).toBeNull();
      expect(readGmailTriageLatest(runsDir)).toBeNull();
    }
  });

  it('fails the write on lock contention and preserves the prior report', () => {
    save('/accounts/alpha');
    const path = gmailTriageLatestPath(runsDir);
    const held = acquireLocalStoreLock(`${path}.lock`, 0, { anchorPath: dirname(path) });
    expect(held).not.toBeNull();
    try {
      expect(() => save('/accounts/beta')).toThrow();
    } finally {
      releaseLocalStoreLock(held);
    }
    expect(readGmailTriageLatest(runsDir)).toMatchObject({ dir: 'alpha' });
    expect(readGmailTriageInboxReports(runsDir)?.inboxes.map(r => r.dir)).toEqual(['alpha']);
    save('/accounts/beta');
    expect(readGmailTriageInboxReports(runsDir)?.inboxes.map(r => r.dir).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('GET /api/verse/comms/gmail-triage inboxes', () => {
  it('serves both count-only reports to a dispatch session', async () => {
    save('/accounts/alpha');
    save('/accounts/beta');
    const { handled, status, body } = await call();
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(body.schema).toBe(GMAIL_TRIAGE_LATEST_SCHEMA);
    expect(body.latest).toMatchObject({ dir: 'beta' });
    expect(body.inboxes).toHaveLength(2);
    expect(body.inboxes.map((r: { dir: string }) => r.dir).sort()).toEqual(['alpha', 'beta']);
    expect(body.evidence).toEqual({ scope: 'saved-local-export-sample', liveInboxTargetState: 'unknown', archiveExecution: 'unverified' });
    const text = JSON.stringify(body);
    expect(text).not.toContain(runsDir);
    expect(text).not.toContain('/accounts');
    for (const report of body.inboxes as Record<string, unknown>[]) {
      expect(Object.keys(report).sort()).toEqual(
        ['archiveCandidateCount', 'at', 'dir', 'drafted', 'failed', 'review', 'scanned', 'schema', 'target', 'unreadInSample', 'updates'].sort(),
      );
    }
  });

  it('keeps missing storage unknown and preserves session gates', async () => {
    const empty = await call();
    expect(empty.body).toMatchObject({
      latest: null, inboxes: null,
      evidence: { scope: 'unknown', liveInboxTargetState: 'unknown', archiveExecution: 'unverified' },
    });
    save('/accounts/alpha');
    writeFileSync(gmailTriageLatestPath(runsDir), '{invalid');
    expect((await call()).body).toMatchObject({ latest: null, inboxes: null, evidence: { scope: 'unknown' } });
    expect((await call('GET', false)).status).toBe(404);
    expect((await call('POST')).status).toBe(405);
  });
});
