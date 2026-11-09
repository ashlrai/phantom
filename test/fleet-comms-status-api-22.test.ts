/** GET /api/verse/fleet/comms-status — the Inbox pane's Comms card feed. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH as PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { approveDraft, createDraft } from '../src/core/cos/drafts.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

const NOW = new Date('2026-11-04T21:00:00.000Z');
const OLDEST = '2026-11-04T10:00:00.000Z';

/** Counts and states only. No handles, message text or paths. */
const absentImessage = {
  configuration: { state: 'disabled', reason: 'CONFIG_DISABLED_OR_INCOMPLETE' },
  chatDb: { state: 'unknown', reason: 'DB_NOT_PROBED' },
  cursor: { state: 'unknown', reason: 'CURSOR_UNAVAILABLE' },
  ackSource: 'missing',
  lastAckAt: null,
  acks24h: 0,
  nextStep: 'Run phm imessage doctor --json to inspect configuration.',
};
const absentTeammate = {
  windowHours: 24,
  targetMinutes: 5,
  texts: 0,
  answered: 0,
  unanswered: 0,
  ignorable: 0,
  medianMinutes: null,
  p90Minutes: null,
  maxMinutes: null,
  withinTarget: 0,
  oldestUnanswered: null,
  sourceState: 'missing',
};

async function call(api: ApiModule, url = PATH, method = 'GET', allowDispatch = true) {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: text ? JSON.parse(text) : null, text };
}

const reply = (to: string, subject: string) =>
  `To: ${to}\nSubject: ${subject}\n\nReply body.\n`;

describe('fleet comms status route', () => {
  it('reports pending drafts and outbox counts, counts only', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'comms-status-'));
    const drop = join(runsDir, 'drop');
    const outbox = join(runsDir, 'outbox');
    await createDraft({ to: 'person@example.test', subject: 'Draft subject one', body: 'body', source: 'one.reply.eml' }, runsDir, () => new Date(OLDEST));
    await createDraft({ to: 'person@example.test', subject: 'Draft subject two', body: 'body', source: 'two.reply.eml' }, runsDir, () => new Date('2026-11-04T15:00:00.000Z'));
    const decided = await createDraft({ to: 'person@example.test', subject: 'Draft subject three', body: 'body', source: 'three.reply.eml' }, runsDir);
    await approveDraft(decided.id, { runsDir });

    // The config names only the inbox; the outbox is derived as <inbox>/../outbox.
    await writeEmailDropConfig(runsDir, { v: 1, inboxDir: drop, from: ['mason@example.test'] });
    await mkdir(join(outbox, 'sending'), { recursive: true });
    await mkdir(join(outbox, 'drafted'), { recursive: true });
    await mkdir(join(outbox, 'sent'), { recursive: true });
    await writeFile(join(outbox, 'a.reply.eml'), reply('person@example.test', 'Queued subject'));
    await writeFile(join(outbox, 'drafted', 'b.reply.eml'), reply('person@example.test', 'Drafted subject'));
    await writeFile(join(outbox, 'sent', 'c.reply.eml'), reply('person@example.test', 'Sent subject'));
    await writeFile(join(outbox, 'sending', 'd.reply.eml'), reply('person@example.test', 'Stuck subject'));

    const result = await call(createFleetCommsStatusApi({ runsDir, now: () => NOW }));
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      version: 1,
      generatedAt: NOW.toISOString(),
      drafts: { pending: 2, oldestPendingAt: OLDEST },
      emailOutbox: { configured: true, queued: 1, drafted: 1, sent: 1, stuck: 1, stuckReasons: { 'interrupted-send': 1 } },
      emailDiagnosis: expect.objectContaining({
        config: 'ok',
        polling: 'enabled',
        sendReplies: 'disabled',
        outbox: 'ok',
        counts: { queued: 1, drafted: 1, sent: 1, stuck: 1 },
        replies: 'blocked',
        coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery',
      }),
      imessage: absentImessage,
      teammate: absentTeammate,
      sources: { drafts: 'healthy', emailOutbox: 'healthy', imessage: 'healthy', teammate: 'missing' },
    });
    // Counts only: no body, subject, address, file name or path crosses the wire.
    for (const secret of ['person@example.test', 'subject', 'reply.eml', runsDir, outbox, drop]) {
      expect(result.text).not.toContain(secret);
    }
  });

  it('reads an explicitly injected outbox dir without a saved config', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'comms-status-'));
    const outbox = await mkdtemp(join(tmpdir(), 'comms-outbox-'));
    await writeFile(join(outbox, 'q.reply.eml'), reply('person@example.test', 'Queued'));
    const result = await call(createFleetCommsStatusApi({ runsDir, outboxDir: outbox, now: () => NOW }));
    expect(result.status).toBe(200);
    expect(result.body.emailOutbox).toEqual({ configured: true, queued: 1, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} });
    expect(result.body.sources).toEqual({ drafts: 'healthy', emailOutbox: 'healthy', imessage: 'healthy', teammate: 'missing' });
    expect(result.body.imessage).toEqual(absentImessage);
    expect(result.body.teammate).toEqual(absentTeammate);
  });

  it('reports a missing email-drop config as not configured, drafts still read', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'comms-status-'));
    await createDraft({ to: 'person@example.test', subject: 'Waiting', body: 'body', source: 'x.reply.eml' }, runsDir);
    const result = await call(createFleetCommsStatusApi({ runsDir, now: () => NOW }));
    expect(result.status).toBe(200);
    expect(result.body.emailOutbox).toEqual({ configured: false, queued: 0, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} });
    expect(result.body.drafts.pending).toBe(1);
    expect(Number.isNaN(Date.parse(result.body.drafts.oldestPendingAt))).toBe(false);
    expect(result.body.sources).toEqual({ drafts: 'healthy', emailOutbox: 'missing', imessage: 'healthy', teammate: 'missing' });
    expect(result.body.imessage).toEqual(absentImessage);
    expect(result.body.teammate).toEqual(absentTeammate);
  });

  it('degrades one section without failing the response', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'comms-status-'));
    // `drafts` as a regular file makes listDrafts throw ENOTDIR.
    await writeFile(join(runsDir, 'drafts'), 'not a directory');
    // An existing but empty outbox dir reads as zero counts, not a missing source.
    await mkdir(join(runsDir, 'nowhere'), { recursive: true });
    const result = await call(createFleetCommsStatusApi({ runsDir, outboxDir: join(runsDir, 'nowhere'), now: () => NOW }));
    expect(result.status).toBe(200);
    expect(result.body.drafts).toBeNull();
    expect(result.body.sources.drafts).toBe('degraded');
    // The outbox section still answered: a configured dir that reads empty is zero, not null.
    expect(result.body.emailOutbox).toEqual({ configured: true, queued: 0, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} });
    expect(result.body.sources.emailOutbox).toBe('healthy');
  });

  it('405s non-GET methods and declines foreign paths', async () => {
    const api = createFleetCommsStatusApi({ runsDir: await mkdtemp(join(tmpdir(), 'comms-status-')) });
    expect(await call(api, PATH, 'POST')).toMatchObject({ handled: true, status: 405 });
    expect((await call(api, '/api/verse/fleet/cos/status')).handled).toBe(false);
    expect((await call(api, '/api/verse/fleet/comms-status/extra')).handled).toBe(false);
  });
});
