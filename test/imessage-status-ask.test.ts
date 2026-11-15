/**
 * RQ-PHX-IMSGSTATUSASK143: a verified-Mason "status" text gets the fixed owner
 * digest back through the same self-only outbox on the same poll; everything
 * else keeps the generic shared ack.
 *
 * Hermetic: poll, maxRowId, platform 'darwin' and runsDir are injected seams,
 * the outbox send is a module mock, node:child_process is stubbed, HOME is a
 * tmp dir, handles are plainly fake, and the statusReply seam injects the
 * composer — the real digest readers never load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSends: { text: string; to: string }[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(null, '', '');
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

vi.mock('../src/core/comms/imessage-outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/imessage-outbox.js')>();
  return {
    ...actual,
    sendIMessageOutbox: async (text: string, _cfg: unknown, to: string) => {
      mockSends.push({ text, to });
      return { ok: true };
    },
  };
});

import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { isOwnerStatusRequest, OWNER_STATUS_FALLBACK } from '../src/core/agents/owner-status-reply.js';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import { readCursor, writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = '+15550000001';
const TEAMMATE = '+15550000002';
const DIGEST = 'Phantom status, 07:30 ET\n1. five-line digest body';
const now = () => new Date('2026-11-11T12:30:00Z');

const cfg = (allow = [MASON, TEAMMATE]): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: allow } }) as AshlrConfig;
const row = (rowid: number, text: string, handle = MASON): IntakeMsg => ({ rowid, handle, text, ts: 1 });

let home = '';
let runsDir = '';
let previousHome: string | undefined;

const ingest = (messages: IntakeMsg[], compose: (runsDir: string, at: Date) => Promise<string> = async () => DIGEST) =>
  ingestIMessages(cfg(), {
    runsDir,
    now,
    platform: 'darwin',
    busRoot: join(runsDir, 'bus'),
    poll: async () => ({ ok: true, messages }),
    maxRowId: async () => ({ ok: true, rowid: 10 }),
    statusReply: { ask: isOwnerStatusRequest, compose, fallback: OWNER_STATUS_FALLBACK },
  });

const acks = () =>
  readFileSync(join(runsDir, 'imessage', 'acks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const teammateRows = () =>
  readFileSync(join(runsDir, 'imessage', 'teammates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  mockSends.length = 0;
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-ask-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-ask-runs-'));
  process.env['HOME'] = home;
  mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
  writeCursor(10, runsDir, now);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

describe('owner status ask over iMessage', () => {
  it('replies to a verified Mason "Phantom status" with the digest, to the Mason handle only', async () => {
    const result = await ingest([row(11, 'Phantom status')]);
    expect(result).toMatchObject({ ok: true, state: 'ingested', accepted: 1, cursor: 11 });
    expect(mockSends).toEqual([{ text: DIGEST, to: MASON }]);
    // The inbox receipt is written exactly as before.
    expect(readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8')).toContain('Phantom status');
    expect(acks()).toHaveLength(1);
    expect(acks()[0]).toMatchObject({ rowid: 11, status: 'accepted', delivery: 'recorded-not-sent' });
  });

  it('does not send a second reply when the same ask is replayed inside the dedupe window', async () => {
    const result = await ingest([row(11, 'status'), row(12, 'status')]);
    expect(result).toMatchObject({ accepted: 1, duplicate: 1, cursor: 12 });
    expect(mockSends).toHaveLength(1);
  });

  it('keeps the generic shared ack for a non-status Mason text', async () => {
    const result = await ingest([row(11, 'please fix the updater')]);
    expect(result).toMatchObject({ accepted: 1 });
    const [line] = acks();
    expect(mockSends).toEqual([{
      text: formatChannelAck({ channel: 'imessage', dedupeKey: line!['receipt'] as string, status: 'accepted' }),
      to: MASON,
    }]);
    expect(mockSends[0]!.text).not.toBe(DIGEST);
  });

  it('never replies to a teammate handle, even when the body is an exact ask', async () => {
    const result = await ingest([row(11, 'status', TEAMMATE)]);
    expect(result).toMatchObject({ accepted: 0, notMason: 1, teammate: 1, cursor: 11 });
    expect(mockSends).toHaveLength(0);
    expect(teammateRows()).toHaveLength(1);
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
  });

  it('sends the owner fallback text when the composer throws, and still advances the cursor', async () => {
    const result = await ingest([row(11, 'status')], async () => { throw new Error('digest read failed'); });
    expect(result).toMatchObject({ ok: true, accepted: 1, cursor: 11 });
    expect(mockSends).toEqual([{ text: OWNER_STATUS_FALLBACK, to: MASON }]);
    expect(readCursor(runsDir)).toBe(11);
  });
});
