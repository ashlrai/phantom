import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH as PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { FleetCommsStatusApiDeps } from '../src/core/verse/fleet-comms-status-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

async function request(deps: FleetCommsStatusApiDeps, allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await createFleetCommsStatusApi(deps)({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, 'GET');
  return { status, text, body: JSON.parse(text) };
}

async function setup() {
  const runsDir = await mkdtemp(join(tmpdir(), 'comms-truth-'));
  return { runsDir, outbox: join(runsDir, 'outbox') };
}

async function config(runsDir: string, outbox: string, options: { enabled?: boolean; sendReplies?: boolean } = {}) {
  await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(runsDir, 'inbox'), outboxDir: outbox, from: ['fixture@example.test'], ...options });
}

describe('comms status local email truth', () => {
  it('reports readable empty and respects injected outbox without reading saved config', async () => {
    const { runsDir, outbox } = await setup();
    await mkdir(outbox);
    const { body } = await request({ runsDir, outboxDir: outbox, emailDiagnosisDeps: { readConfig: async () => { throw new Error('must not read'); } } });
    expect(body.sources.emailOutbox).toBe('healthy');
    expect(body.emailOutbox).toEqual({ configured: true, queued: 0, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} });
    expect(body.emailDiagnosis).toMatchObject({ config: 'ok', outbox: 'ok', replies: 'draft-only' });
  });

  it.each(['missing', 'not-directory'] as const)('degrades configured %s storage', async (kind) => {
    const { runsDir, outbox } = await setup();
    if (kind === 'not-directory') await writeFile(outbox, 'fixture');
    await config(runsDir, outbox);
    const { body, text } = await request({ runsDir });
    expect(body.sources.emailOutbox).toBe('degraded');
    expect(body.emailOutbox).toBeNull();
    expect(body.emailDiagnosis).toMatchObject({ outbox: kind, counts: null, replies: 'blocked' });
    expect(text).not.toContain(outbox);
  });

  it('degrades a collector listing failure without exposing exception text', async () => {
    const { runsDir, outbox } = await setup();
    await mkdir(outbox);
    const { body, text } = await request({ runsDir, outboxDir: outbox, emailDiagnosisDeps: { listOutbox: () => { throw new Error('private failure'); } } });
    expect(body.sources.emailOutbox).toBe('degraded');
    expect(body.emailOutbox).toBeNull();
    expect(body.emailDiagnosis).toMatchObject({ outbox: 'unreadable', counts: null, replies: 'blocked' });
    expect(text).not.toContain('private failure');
  });

  it('distinguishes invalid and missing configuration', async () => {
    const { runsDir } = await setup();
    let result = await request({ runsDir });
    expect(result.body.sources.emailOutbox).toBe('missing');
    expect(result.body.emailOutbox.configured).toBe(false);
    expect(result.body.emailDiagnosis).toMatchObject({ config: 'missing', replies: 'not-configured', counts: null });
    await mkdir(join(runsDir, 'queue'));
    await writeFile(join(runsDir, 'queue', 'email-drop.json'), '{invalid');
    result = await request({ runsDir });
    expect(result.body.sources.emailOutbox).toBe('degraded');
    expect(result.body.emailOutbox).toBeNull();
    expect(result.body.emailDiagnosis).toMatchObject({ config: 'invalid', replies: 'not-configured' });
  });

  it('reports draft-only, paused and sent artifacts as local evidence', async () => {
    const { runsDir, outbox } = await setup();
    await mkdir(join(outbox, 'drafted'), { recursive: true });
    await mkdir(join(outbox, 'sent'));
    await writeFile(join(outbox, 'drafted', 'fixture.reply.eml'), 'To: fixture@example.test\nSubject: private fixture\n\nprivate body');
    await writeFile(join(outbox, 'sent', 'sent.reply.eml'), 'fixture');
    await config(runsDir, outbox);
    let result = await request({ runsDir });
    expect(result.body.emailDiagnosis).toMatchObject({ replies: 'draft-only', counts: { drafted: 1, sent: 1 }, coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery' });
    for (const value of [runsDir, 'fixture@example.test', 'private fixture', 'private body', 'fixture.reply.eml']) expect(result.text).not.toContain(value);
    await config(runsDir, outbox, { enabled: false, sendReplies: true });
    result = await request({ runsDir });
    expect(result.body.emailDiagnosis).toMatchObject({ replies: 'paused', polling: 'paused', sendReplies: 'enabled' });
    expect((await request({ runsDir }, false)).status).toBe(404);
  });
});
