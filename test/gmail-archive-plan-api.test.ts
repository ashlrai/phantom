import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';
import { createGmailTriageApi, VERSE_GMAIL_ARCHIVE_PLAN_PATH as PATH } from '../src/core/verse/gmail-triage-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'archive-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

async function call(method = 'GET', allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await createGmailTriageApi({ runsDir })({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('GET /api/verse/comms/gmail-triage/archive-plan', () => {
  it('serves null before a save and the saved plans after', async () => {
    expect((await call()).body).toEqual({ schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, latest: null });
    writeGmailArchivePlanLatest(runsDir, { inbox: 'inbox-a', unread: 120, target: 100, archiveCount: 20, topSenders: [{ sender: 'sender@example.com', count: 12 }] });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.latest.plans[0]).toMatchObject({ inbox: 'inbox-a', archiveCount: 20 });
  });

  it('rejects other methods and non-dispatch sessions', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('GET', false)).status).toBe(404);
  });
});
