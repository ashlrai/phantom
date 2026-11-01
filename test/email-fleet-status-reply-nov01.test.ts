import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordEmailToInbox, runEmailDropOnce } from '../src/core/comms/email-drop-bridge.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import { emailFleetStatus } from '../src/core/comms/email-fleet-status.js';
import type { StatusSupply } from '../src/core/comms/status-supply-line.js';

let root: string;
let inboxDir: string;
let outboxDir: string;
let processedDir: string;
let runsDir: string;
const now = () => new Date('2026-11-01T04:08:00.000Z');
const allowedSenders = new Set(['mason@example.com']);
const message = (body = '/fleet-status', from = 'Mason <mason@example.com>', id = '<status-1@example.com>', subject = 'status') =>
  `From: ${from}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\n\r\n${body}\r\n`;
const files = () => existsSync(outboxDir) ? readdirSync(outboxDir) : [];
const drop = (raw: string) => writeFileSync(join(inboxDir, 'request.eml'), raw);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'email-fleet-status-'));
  inboxDir = join(root, 'in'); outboxDir = join(root, 'out');
  processedDir = join(root, 'processed'); runsDir = join(root, 'runs');
  mkdirSync(inboxDir); mkdirSync(runsDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('drop-folder fleet status', () => {
  it('appends supply and planner projections and contains reader failures', async () => {
    const supply: StatusSupply = { v: 1, sourceState: 'healthy', lanes: [{ lane: 'devin', phxReady: 2, fillerReady: 3 }],
      planner: { status: 'ok', lastGoodPassAt: '2026-11-01T04:07:00.000Z', reason: null } };
    const workers = () => listLiveWorkers({ now: () => now().getTime(), runPs: async () => '' });
    const body = await emailFleetStatus(runsDir, now, { workers, supply: async () => supply });
    expect(body.split('\n').slice(-2)).toEqual(['Supply: devin 2 phantom / 3 filler', 'Planner: last good pass 2026-11-01T04:07:00.000Z']);
    const failed = await emailFleetStatus(runsDir, now, { workers, supply: async () => { throw new Error('private'); } });
    expect(failed.split('\n').slice(-2)).toEqual(['Supply: unavailable', 'Planner: unknown (unavailable)']);
  });
  it('queues one threaded, counts-only reply and suppresses replays even with a changed body', async () => {
    const state = await readFleetRunsDirState({ runsDir, now: () => now().getTime() });
    state.sources.status = 'healthy'; state.paused = false;
    state.lanes = [{ lane: 'secret-path', running: 2, target: 3, queued: 1, held: true,
      floor: null, ceiling: null, heldReason: '/private/key secret', tokensLastHour: null, merged24h: null, mergeRate24h: null }];
    state.events = [{ at: '', kind: 'secret', text: '/private/raw-log-secret' }];
    const snapshot = await listLiveWorkers({ now: () => now().getTime(), runPs: async () => '' });
    snapshot.workers = [{ pid: 1, job: 'secret-job', repo: 'private-repo', lane: 'codex', tier: 'work', ageSeconds: 2 }];
    const runs = vi.fn(async () => state);
    const workers = vi.fn(async () => snapshot);
    const opts = { inboxDir, outboxDir, processedDir, runsDir, allowedSenders, now, statusReaders: { runs, workers } };
    drop(message('/fleet-status', 'Mason <mason@example.com>', '<status-1@example.com>', 'secret subject /private/key'));
    expect(await runEmailDropOnce(opts)).toEqual({ accepted: 1, duplicate: 0, refused: 0, failed: 0, status: { queued: 1, duplicate: 0 } });
    expect(files()).toHaveLength(1);
    const reply = readFileSync(join(outboxDir, files()[0]!), 'utf8');
    expect(reply).toContain('To: mason@example.com\r\n');
    expect(reply).toContain('In-Reply-To: <status-1@example.com>\r\nReferences: <status-1@example.com>');
    expect(reply).toContain('running: 2'); expect(reply).toContain('Live workers: 1');
    expect(reply).not.toMatch(/secret|private|raw-log|Inbox:/i);
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
    expect(readdirSync(processedDir)).toEqual(['request.eml']);
    drop(message());
    expect(await runEmailDropOnce(opts)).toEqual({ accepted: 0, duplicate: 1, refused: 0, failed: 0, status: { queued: 0, duplicate: 1 } });
    drop(message('do engineering work'));
    expect(await runEmailDropOnce(opts)).toEqual({ accepted: 0, duplicate: 1, refused: 0, failed: 0, status: { queued: 0, duplicate: 1 } });
    expect(files()).toHaveLength(1); expect(runs).toHaveBeenCalledTimes(1); expect(workers).toHaveBeenCalledTimes(1);
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
  });

  it('refuses an unlisted sender before any status read despite forged authentication headers', async () => {
    const runs = vi.fn(); const workers = vi.fn();
    drop(message('/fleet-status', 'intruder@example.net').replace('Subject:', 'Authentication-Results: pass\r\nSubject:'));
    expect(await runEmailDropOnce({ inboxDir, outboxDir, processedDir, runsDir, allowedSenders, now, statusReaders: { runs, workers } }))
      .toEqual({ accepted: 0, duplicate: 0, refused: 1, failed: 0 });
    expect(runs).not.toHaveBeenCalled(); expect(workers).not.toHaveBeenCalled(); expect(files()).toHaveLength(0);
  });

  it('reports unavailable sources rather than treating missing data as zero', async () => {
    const workers = () => listLiveWorkers({ now: () => now().getTime(), runPs: async () => { throw new Error('private'); } });
    const result = await recordEmailToInbox(message(), { allowedSenders, runsDir, outboxDir, now, statusReaders: { workers } });
    expect(result).toEqual({ ok: false, kind: 'status', reason: 'status-queued' });
    const reply = readFileSync(join(outboxDir, files()[0]!), 'utf8');
    expect(reply).toContain('Runs status: unavailable'); expect(reply).toContain('Live workers: unavailable');
    expect(reply).not.toContain('private');
  });

  it('requires a safe ID and an outbox without reading status', async () => {
    const runs = vi.fn(async () => { throw new Error('unavailable'); });
    const workers = () => listLiveWorkers({ now: () => now().getTime(), runPs: async () => '' });
    for (const raw of [message('/fleet-status', 'mason@example.com', '<bad>'), message('/fleet-status', 'mason@example.com', '<bad@x>\r\nBcc: victim@example.com')]) {
      // Header injection is parsed as a separate header, never copied to the reply.
      if (raw.includes('Bcc:')) {
        const result = await recordEmailToInbox(raw, { allowedSenders, runsDir, outboxDir, now, statusReaders: { runs, workers } });
        expect(result).toMatchObject({ kind: 'status', reason: 'status-queued' });
        expect(readFileSync(join(outboxDir, files()[0]!), 'utf8')).not.toContain('Bcc:');
      } else expect(await recordEmailToInbox(raw, { allowedSenders, runsDir, outboxDir, now, statusReaders: { runs } })).toEqual({ ok: false, reason: 'invalid' });
    }
    const result = await recordEmailToInbox(message(), { allowedSenders, runsDir, now, statusReaders: { runs } });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('does not recognize a subject, quoted text, or additional body as the exact command', async () => {
    for (const [index, body] of ['ordinary text', '/fleet-status\n> quoted', '/fleet-status\nextra'].entries()) {
      const result = await recordEmailToInbox(message(body, 'mason@example.com', `<normal-${index}@example.com>`, '/fleet-status'), { allowedSenders, runsDir, outboxDir, now });
      expect(result.ok && result.ack.status).toBe('accepted');
    }
    const inbox = readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox).toContain('ordinary text');
  });
});
