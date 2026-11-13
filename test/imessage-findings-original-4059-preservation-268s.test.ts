/**
 * RQ-PHX-FINDINGSORIGINALRECONCILE268S: executable preservation evidence for
 * original open PR #4059 (RQ-SWE3-DOTFEED-TTL-1) against current master.
 *
 * The original isolated suites (test/imessage-findings-bridge.test.ts,
 * test/imessage-teammate-ingest.test.ts) are byte-identical on master; this
 * suite adds the missing combined lifecycle: real ingestIMessages -> durable
 * teammate inbox -> bridgeTeammateFindings -> real listBusInboxAfter, with a
 * fake clock, temporary state dirs and synthetic messages. Only the external
 * poll/platform boundary and the unrelated owner-status reply are stubbed;
 * the bridge, bus store, teammate ledger and patch frame gate all run real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { CHANNEL_BUS_TTL_MS } from '../src/core/fleet/channel-bus-publish.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readCursor, writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = 'mason@example.test';
const TEAMMATE = 'team-mate@example.test';
const TEAMMATE_SENDER = senderIdFor(TEAMMATE);
const OWNER_TEXT = 'owner-only directive: rotate the deploy key';
const FINDING_A = 'teammate finding alpha: gate is red on lane work';
const FINDING_B = 'teammate finding beta: bus cursor drifted';

let home = '';
let runsDir = '';
let busRoot = '';
let clock = new Date();
let previousHome: string | undefined;

const now = () => clock;
const cfg = (): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON, TEAMMATE] } }) as AshlrConfig;
const row = (rowid: number, handle: string, text: string): IntakeMsg => ({ rowid, handle, text, ts: 1 });

const ingest = (messages: IntakeMsg[]) =>
  ingestIMessages(cfg(), {
    runsDir, busRoot, now, platform: 'darwin',
    poll: async () => ({ ok: true, messages }),
    statusReply: { ask: () => false, compose: async () => 'unused', fallback: 'unused' },
  });
const busEnvelopes = () => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map((m) => m.envelope) : [];
};
const teammateRows = () =>
  readFileSync(join(runsDir, 'imessage', 'teammates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-pres-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-pres-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'imsg-pres-bus-'));
  clock = new Date();
  process.env['HOME'] = home;
  mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
  writeCursor(10, runsDir, now);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

describe('PR #4059 preservation: findings lifecycle through real ingest and bus', () => {
  it('persists an allowlisted teammate finding as an untrusted note and mirrors only teammate text', async () => {
    const result = await ingest([row(11, TEAMMATE, FINDING_A), row(12, MASON, OWNER_TEXT), row(13, TEAMMATE, FINDING_B)]);
    expect(result).toMatchObject({ ok: true, state: 'ingested', scanned: 3, accepted: 1, notMason: 2, teammate: 2, cursor: 13 });
    expect(result.findings).toMatchObject({ state: 'healthy', posted: 2, lastRowid: 13 });

    // Durable teammate inbox: hashed sender, deterministic rowid-keyed record, raw handle never stored.
    const rows = teammateRows();
    expect(rows.map((r) => r.rowid)).toEqual([11, 13]);
    for (const r of rows) {
      expect(r.senderId).toBe(TEAMMATE_SENDER);
      expect(r.senderId).toMatch(/^imessage:[a-f0-9]{16}$/);
    }
    expect(JSON.stringify(rows)).not.toContain(TEAMMATE);
    expect(JSON.stringify(rows)).not.toContain(OWNER_TEXT);

    // Bus: one note envelope per teammate row, id derives from chat.db rowid.
    const envelopes = busEnvelopes();
    expect(envelopes.map((e) => e.id)).toEqual(['imessage-teammate-11', 'imessage-teammate-13']);
    for (const e of envelopes) {
      expect(e).toMatchObject({
        to: TEAMMATE_FINDINGS_TOPIC,
        from: TEAMMATE_SENDER,
        channel: 'imessage',
        sender: { agent_id: TEAMMATE_SENDER, vendor: 'imessage', human: false, team: true },
        external: false,
      });
      // The store reports remaining TTL; the envelope was stamped with the full bus TTL.
      expect(e.ttl).toBeGreaterThan(0);
      expect(e.ttl).toBeLessThanOrEqual(CHANNEL_BUS_TTL_MS);
      expect(e.body).toMatchObject({ kind: 'note' });
      expect(e.body).not.toMatchObject({ kind: 'work' });
    }
    const busJson = JSON.stringify(envelopes);
    expect(busJson).toContain(FINDING_A);
    expect(busJson).toContain(FINDING_B);
    expect(busJson).not.toContain(OWNER_TEXT);
    expect(busJson).not.toContain(MASON);
    expect(busJson).not.toContain(TEAMMATE);

    // Findings are data, never executable work: the owner path may enqueue its
    // own COS job, but nothing derived from a teammate finding reaches the queue.
    const queueDir = join(runsDir, 'queue');
    const queueText = existsSync(queueDir)
      ? readdirSync(queueDir).map((f) => readFileSync(join(queueDir, f), 'utf8')).join('\n')
      : '';
    expect(queueText).not.toContain(FINDING_A);
    expect(queueText).not.toContain(FINDING_B);
    expect(queueText).not.toContain(TEAMMATE);
    expect(readCursor(runsDir)).toBe(13);
  });

  it('replay and a later empty poll leave exactly one envelope per finding', async () => {
    const batch = [row(11, TEAMMATE, FINDING_A), row(12, MASON, OWNER_TEXT), row(13, TEAMMATE, FINDING_B)];
    await ingest(batch);
    expect(busEnvelopes()).toHaveLength(2);

    // Replay: the same rows return from the poll boundary again. The teammate
    // ledger dedupes by rowid and the durable watermark plus the deterministic
    // envelope id keep the bus at one envelope per finding.
    const replay = await ingest(batch);
    expect(replay.findings).toMatchObject({ examined: 0, posted: 0, lastRowid: 13 });
    expect(teammateRows()).toHaveLength(2);
    expect(busEnvelopes().map((e) => e.id)).toEqual(['imessage-teammate-11', 'imessage-teammate-13']);

    // A later empty poll changes nothing.
    const empty = await ingest([]);
    expect(empty).toMatchObject({ ok: true, scanned: 0 });
    expect(empty.findings).toMatchObject({ examined: 0, posted: 0, lastRowid: 13 });
    expect(busEnvelopes()).toHaveLength(2);
  });

  it('never revives findings past CHANNEL_BUS_TTL_MS: the watermark blocks repost and an expired row is refused', async () => {
    await ingest([row(11, TEAMMATE, FINDING_A)]);
    expect(busEnvelopes()).toHaveLength(1);

    // Move the fake clock past the bus TTL. The watermark still covers rowid
    // 11, so the bridge never re-examines it: no fresh append, no TTL revival.
    clock = new Date(clock.getTime() + CHANNEL_BUS_TTL_MS + 1000);
    const afterTtl = await ingest([]);
    expect(afterTtl.findings).toMatchObject({ examined: 0, posted: 0, refused: 0, lastRowid: 11 });
    expect(busEnvelopes()).toHaveLength(1);

    // A row recorded long ago but never bridged is terminal: refused, counted,
    // and the watermark advances past it so no later pass rescans it.
    appendFileSync(
      join(runsDir, 'imessage', 'teammates.jsonl'),
      `${JSON.stringify({ v: 1, at: new Date(clock.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), rowid: 14, senderId: TEAMMATE_SENDER, text: 'ancient unbridged finding' })}\n`,
    );
    const expired = await ingest([]);
    expect(expired.findings).toMatchObject({ examined: 1, posted: 0, refused: 1, lastRowid: 14 });
    expect(busEnvelopes()).toHaveLength(1);
    expect(busEnvelopes()[0]!.id).toBe('imessage-teammate-11');
  });
});
