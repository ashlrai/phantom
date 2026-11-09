import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_TRIAGE_LATEST_SCHEMA, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';
import { createGmailTriageApi, VERSE_GMAIL_TRIAGE_PATH as PATH } from '../src/core/verse/gmail-triage-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'gmail-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

async function call(method = 'GET', allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await createGmailTriageApi({ runsDir })({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('GET /api/verse/comms/gmail-triage', () => {
  it('serves null before a save and the saved object after', async () => {
    expect((await call()).body).toEqual({ schema: GMAIL_TRIAGE_LATEST_SCHEMA, latest: null });
    writeGmailTriageLatest(runsDir, { dir: 'mail', scanned: 2, updates: 1, drafted: 0, review: 0, failed: 0, unreadInSample: 2, target: 100, archiveCandidateCount: 0 });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.latest).toMatchObject({ dir: 'mail', scanned: 2, updates: 1 });
  });

  it('rejects other methods and non-dispatch sessions', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('GET', false)).status).toBe(404);
  });
});
