/**
 * RQ-PHX-TEAMMATETEXTS25: allowlisted non-Mason iMessages land in the local
 * teammate inbox instead of being dropped.
 *
 * Hermetic: node:child_process is mocked (no osascript/sqlite3), HOME and
 * runsDir are tmp dirs, handles are placeholders, and the platform is patched
 * to darwin exactly the way the existing imessage bridge tests do.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { ingestIMessages, senderIdFor } from '../src/core/comms/imessage-inbox-bridge.js';
import { TEAMMATE_FINDINGS_TOPIC } from '../src/core/comms/imessage-findings-bridge.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readCursor, writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = 'mason@example.test';
const TEAMMATE = 'teammate@example.test';
const now = () => new Date('2026-11-04T23:46:00Z');
const cfg = (): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON, TEAMMATE] } }) as AshlrConfig;
const row = (rowid: number, handle: string, text: string): IntakeMsg => ({ rowid, handle, text, ts: 1 });

let home = '';
let runsDir = '';
let previousHome: string | undefined;

const busRoot = () => join(runsDir, 'bus');
const ingest = (messages: IntakeMsg[]) =>
  ingestIMessages(cfg(), { runsDir, busRoot: busRoot(), now, platform: 'darwin', poll: async () => ({ ok: true, messages }) });
const inboxPath = () => join(runsDir, 'leader', 'MASON-INBOX.md');
const busEnvelopes = () => {
  const page = listBusInboxAfter(0, 100, { root: busRoot() });
  return page.status === 'ok' ? page.messages.map((m) => m.envelope) : [];
};
const teammateRows = () =>
  readFileSync(join(runsDir, 'imessage', 'teammates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-runs-'));
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

describe('teammate intake', () => {
  it('does not advance the cursor when the teammate ledger cannot persist', async () => {
    writeFileSync(join(runsDir, 'imessage', 'teammates.jsonl'), '');
    rmSync(join(runsDir, 'imessage', 'teammates.jsonl'));
    mkdirSync(join(runsDir, 'imessage', 'teammates.jsonl'));
    const result = await ingest([row(11, TEAMMATE, 'Please preserve this artifact')]);
    expect(result).toMatchObject({ ok: false, deferred: true, cursor: 10, teammate: 0 });
    expect(readCursor(runsDir)).toBe(10);
    // The mirror cannot read a directory-as-file either, but it never blocks intake.
    expect(result.findings).toMatchObject({ posted: 0 });
  });
  it('keeps a teammate text in the local inbox, never in MASON-INBOX.md or the queue', async () => {
    const result = await ingest([row(11, TEAMMATE, 'hey ashlr, the gate is red')]);
    expect(result).toMatchObject({ ok: true, state: 'ingested', scanned: 1, accepted: 0, notMason: 1, teammate: 1, cursor: 11 });
    expect(readCursor(runsDir)).toBe(11);

    const rows = teammateRows();
    expect(rows).toEqual([{ v: 1, at: now().toISOString(), rowid: 11, senderId: senderIdFor(TEAMMATE), text: 'hey ashlr, the gate is red' }]);
    expect(JSON.stringify(rows)).not.toContain(TEAMMATE);

    // RQ-SWE3-DOTFEED-1: the durable row also mirrors onto the findings topic.
    expect(result.findings).toMatchObject({ state: 'healthy', posted: 1, lastRowid: 11 });
    const envelopes = busEnvelopes();
    expect(envelopes.map((e) => e.id)).toEqual(['imessage-teammate-11']);
    expect(envelopes[0]).toMatchObject({ to: TEAMMATE_FINDINGS_TOPIC, from: senderIdFor(TEAMMATE), channel: 'imessage', body: { kind: 'note', text: 'hey ashlr, the gate is red' } });
    expect(JSON.stringify(envelopes)).not.toContain(TEAMMATE);

    expect(existsSync(inboxPath())).toBe(false);
    expect(existsSync(join(runsDir, 'queue'))).toBe(false);
    expect(existsSync(join(runsDir, 'agent-bus'))).toBe(false);
    expect(existsSync(join(runsDir, 'imessage', 'acks.jsonl'))).toBe(false);
  });

  // Spoof only intake availability: real filesystem custody must use this host OS.
  it("keeps Mason's path unchanged in a mixed batch", async () => {
    const result = await ingest([row(11, TEAMMATE, 'teammate ping'), row(12, MASON, 'mason order'), row(13, TEAMMATE, 'teammate followup')]);
    expect(result).toMatchObject({ ok: true, deferred: false, scanned: 3, accepted: 1, notMason: 2, teammate: 2, cursor: 13 });

    const inbox = readFileSync(inboxPath(), 'utf8');
    expect(inbox).toContain('mason order');
    expect(inbox).not.toContain('teammate ping');
    expect(inbox).not.toContain('teammate followup');
    expect(teammateRows().map((r) => r.rowid)).toEqual([11, 13]);

    // Only teammate rows mirror to the findings topic; Mason's text never does.
    expect(result.findings).toMatchObject({ posted: 2, lastRowid: 13 });
    expect(busEnvelopes().map((e) => e.id)).toEqual(['imessage-teammate-11', 'imessage-teammate-13']);
  });

  it('refuses unsupported intake without polling or writing owner state', async () => {
    const poll = vi.fn();
    expect(await ingestIMessages(cfg(), { runsDir, now, platform: 'linux', poll })).toMatchObject({ ok: false, state: 'unsupported' });
    expect(poll).not.toHaveBeenCalled(); expect(readCursor(runsDir)).toBe(10);
    expect(existsSync(inboxPath())).toBe(false);
  });

  it('still baselines and reports disabled/unsupported the old way', async () => {
    rmSync(join(runsDir, 'imessage', 'cursor.json'));
    const result = await ingestIMessages(cfg(), {
      runsDir, now, platform: 'darwin',
      poll: async () => ({ ok: true, messages: [row(99, TEAMMATE, 'late')] }),
      maxRowId: async () => ({ ok: true, rowid: 42 }),
    });
    expect(result).toMatchObject({ ok: true, state: 'baselined', teammate: 0 });
    expect(existsSync(join(runsDir, 'imessage', 'teammates.jsonl'))).toBe(false);
  });
});
