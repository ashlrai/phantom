import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gmailTriageLatestPath, writeGmailTriageLatest, GMAIL_TRIAGE_LATEST_SCHEMA } from '../src/core/comms/gmail-triage-latest.js';
import { gmailArchivePlanLatestPath, writeGmailArchivePlanLatest, GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA } from '../src/core/comms/gmail-archive-plan-latest.js';
import { createGmailTriageApi, VERSE_GMAIL_TRIAGE_PATH, VERSE_GMAIL_ARCHIVE_PLAN_PATH } from '../src/core/verse/gmail-triage-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'gmail-evidence-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

async function call(path: string, method = 'GET', allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await createGmailTriageApi({ runsDir })({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const paths = [VERSE_GMAIL_TRIAGE_PATH, VERSE_GMAIL_ARCHIVE_PLAN_PATH];
const unknown = { scope: 'unknown', liveInboxTargetState: 'unknown', archiveExecution: 'unverified' };
const sample = { ...unknown, scope: 'saved-local-export-sample' };

describe('saved Gmail evidence', () => {
  it('reports unknown scope for missing and invalid records on both routes', async () => {
    for (const path of paths) {
      expect((await call(path)).body).toMatchObject({ latest: null, evidence: unknown });
    }
    for (const file of [gmailTriageLatestPath(runsDir), gmailArchivePlanLatestPath(runsDir)]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{invalid');
    }
    for (const path of paths) {
      expect((await call(path)).body).toMatchObject({ latest: null, evidence: unknown });
    }
  });

  it('identifies saved samples without inferring live health or archive execution', async () => {
    writeGmailTriageLatest(runsDir, { dir: 'export', scanned: 100, updates: 0, drafted: 0, review: 0, failed: 0, unreadInSample: 100, target: 100, archiveCandidateCount: 2 });
    for (const inbox of ['one@example.test', 'two@example.test']) {
      writeGmailArchivePlanLatest(runsDir, { inbox, unread: 100, target: 100, archiveCount: 2, topSenders: [{ sender: 'sender@example.test', count: 2 }] });
    }
    const triage = await call(paths[0]);
    expect(triage).toMatchObject({ handled: true, status: 200, body: { schema: GMAIL_TRIAGE_LATEST_SCHEMA, latest: { unreadInSample: 100, target: 100 }, evidence: sample } });
    const archive = await call(paths[1]);
    expect(archive).toMatchObject({ handled: true, status: 200, body: { schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, evidence: sample } });
    expect(archive.body.latest.plans).toHaveLength(2);
    expect(JSON.stringify([triage.body, archive.body])).not.toContain(runsDir);
  });

  it('preserves authorization and method behavior on both routes', async () => {
    for (const path of paths) {
      expect(await call(path, 'GET', false)).toEqual({ handled: true, status: 404, body: { error: 'not found' } });
      expect(await call(path, 'POST')).toEqual({ handled: true, status: 405, body: { error: 'The Gmail triage result is read only here.' } });
    }
  });
});
