/**
 * RQ-PHX-RECUTCOMMSC157: pins the behavior recovered by the recut of #4966
 * (itself a recut of #4073, RQ-SWE3-IMSGDEEP-1): chunked PATCH-BEGIN/PART/END
 * transfers wired through the teammate inbox, the findings bridge and the
 * intake result.
 *
 * Every assertion here fails on origin/master, where the leaf module does not
 * export isPatchFrameText, the findings bridge has no teammatePatchEnvelope,
 * protocol count or announcedPatchIds ring, and ingestIMessages reports no
 * patch tallies. Handles, senders and message ids are plainly fake; nothing
 * real is polled or sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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

import * as leafModule from '../src/core/comms/imessage-teammate-inbox.js';
import { senderIdFor, teammateNeedsReply } from '../src/core/comms/imessage-teammate-inbox.js';
import * as transferModule from '../src/core/comms/imessage-patch-transfer.js';
import { isPatchFrameText } from '../src/core/comms/imessage-patch-transfer.js';
import * as findingsModule from '../src/core/comms/imessage-findings-bridge.js';
import { bridgeTeammateFindings, TEAMMATE_FINDINGS_TOPIC } from '../src/core/comms/imessage-findings-bridge.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = 'mason@example.test';
const TEAMMATE = 'teammate@example.test';
const NOW = new Date('2026-11-10T12:00:00Z');
const SHA = createHash('sha256').update('payload', 'utf8').digest('hex');

// Dynamic lookups for the exports this recut restores: on master they are
// undefined and the assertions fail inside the test rather than at import.
const leaf = leafModule as unknown as { isPatchFrameText?: (text: string) => boolean };
const findings = findingsModule as unknown as {
  teammatePatchEnvelope?: (receipt: Record<string, unknown>) => BusEnvelope | null;
};

const cfg = (): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON, TEAMMATE] } }) as AshlrConfig;
const row = (rowid: number, text: string, handle = TEAMMATE): IntakeMsg => ({ rowid, handle, text, ts: 1 });

let runsDir = '';
let previousHome: string | undefined;
let home = '';

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'recut-c157-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'recut-c157-runs-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

describe('leaf marker placement', () => {
  it('defines isPatchFrameText once in the leaf and re-exports it through the transfer module', () => {
    expect(leaf.isPatchFrameText).toBe(isPatchFrameText);
    expect(isPatchFrameText(`PATCH-BEGIN fix-9 2 ${SHA}`)).toBe(true);
    expect(isPatchFrameText('PATCH-FOO x')).toBe(false);
  });

  it('treats a PATCH frame as protocol even when its chunk reads like a request', () => {
    expect(teammateNeedsReply('PATCH-PART fix-9 1/2\ncan you review this?')).toBe(false);
    // A genuine teammate request still needs a reply.
    expect(teammateNeedsReply('can you review the diff?')).toBe(true);
  });
});

describe('teammatePatchEnvelope', () => {
  const receipt = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ v: 1, id: 'fix-9', outcome: 'verified', sha256: SHA, parts: 2, bytes: 44, rowids: [11, 12, 13, 14], senderId: senderIdFor(TEAMMATE), completedAt: NOW.toISOString(), ...over });

  it('maps a verified receipt to a deterministic metadata-only note', () => {
    const env = findings.teammatePatchEnvelope?.(receipt());
    expect(env).toMatchObject({
      id: 'imessage-patch-fix-9',
      from: senderIdFor(TEAMMATE),
      to: TEAMMATE_FINDINGS_TOPIC,
      channel: 'imessage',
      external: false,
      body: { kind: 'note', thread: senderIdFor(TEAMMATE) },
    });
    // Metadata only: the patch body and the raw handle never leave the box.
    expect(env?.body.kind === 'note' && env.body.text).toContain('sha256');
    expect(JSON.stringify(env)).not.toContain(TEAMMATE);
    expect(JSON.stringify(env)).not.toContain('payload');
  });

  it('refuses receipts that can never be announced', () => {
    expect(findings.teammatePatchEnvelope?.(receipt({ outcome: 'rejected' }))).toBeNull();
    expect(findings.teammatePatchEnvelope?.(receipt({ outcome: 'expired' }))).toBeNull();
    expect(findings.teammatePatchEnvelope?.(receipt({ id: '../escape' }))).toBeNull();
  });

  it('refuses a receipt whose sender is not a canonical team id (drafts-only gate)', () => {
    // An artifact attributed to a raw handle or an external id can never be
    // announced on the bus: for a non-team sender nothing leaves the box —
    // no envelope, no send path, draft-shaped local evidence only.
    expect(findings.teammatePatchEnvelope?.(receipt({ senderId: TEAMMATE }))).toBeNull();
    expect(findings.teammatePatchEnvelope?.(receipt({ senderId: 'external:+15555550100' }))).toBeNull();
    expect(findings.teammatePatchEnvelope?.(receipt({ senderId: '' }))).toBeNull();
  });
});

describe('bridgeTeammateFindings patch announcements', () => {
  it('counts frame rows as protocol and announces a verified receipt exactly once', () => {
    const posted: BusEnvelope[] = [];
    const options = {
      runsDir,
      now: () => NOW,
      readTexts: () => ({
        sourceState: 'healthy' as const,
        texts: [
          { at: NOW.toISOString(), rowid: 11, senderId: senderIdFor(TEAMMATE), text: `PATCH-PART fix-9 1/2\nchunk`, ageMinutes: 0 },
          { at: NOW.toISOString(), rowid: 12, senderId: senderIdFor(TEAMMATE), text: 'ordinary finding', ageMinutes: 0 },
        ],
      }),
      readReceipts: () => ({
        state: 'healthy' as const,
        receipts: [{ v: 1, id: 'fix-9', outcome: 'verified' as const, sha256: SHA, parts: 2, bytes: 44, rowids: [11], senderId: senderIdFor(TEAMMATE), completedAt: NOW.toISOString() }],
      }),
      append: (envelope: BusEnvelope) => { posted.push(envelope); return { status: 'posted' as const }; },
    };
    const first = bridgeTeammateFindings(options);
    expect(first).toMatchObject({ protocol: 1, posted: 1, announced: 1, lastRowid: 12 });
    expect(posted.map((e) => e.id).sort()).toEqual(['imessage-patch-fix-9', 'imessage-teammate-12']);
    // The frame row was consumed by the transfer state, never enveloped.
    expect(posted.every((e) => e.body.kind === 'note' && !e.body.text.includes('chunk'))).toBe(true);

    // The watermark and announcedPatchIds ring are durable: a second pass
    // never re-announces and never reposts a handled row.
    const second = bridgeTeammateFindings(options);
    expect(second.announced).toBe(0);
    expect(posted).toHaveLength(2);
  });
});

describe('ingestIMessages patch tallies', () => {
  const seams = (messages: IntakeMsg[]) => ({
    runsDir,
    now: () => NOW,
    platform: 'darwin' as const,
    poll: async () => ({ ok: true as const, messages }),
    patchFrame: (msg: { rowid: number; handle: string; text: string }) =>
      transferModule.isPatchFrameText(msg.text)
        ? { handled: true, outcome: 'consumed' as const, id: 'fix-9' }
        : { handled: false, outcome: 'refused' as const },
    patchSweep: () => ({ schema: 'imessage.patch-transfer.v1' as const, state: 'healthy' as const, examined: 0, expired: 0, open: 0, lastRowid: 0 }),
  });

  it('reports frame tallies merged with the sweep while teammate rows stay unsent', async () => {
    writeCursor(10, runsDir, () => NOW);
    const result = await ingestIMessages(cfg(), seams([
      row(11, `PATCH-BEGIN fix-9 2 ${SHA}`),
      row(12, 'ordinary teammate text'),
    ]));
    expect(result).toMatchObject({ ok: true, state: 'ingested', teammate: 2, accepted: 0 });
    expect(result.patches).toMatchObject({ frames: 1, completed: 0, expired: 0 });
    // accepted 0: a non-Mason sender is never receipted as operator input, so
    // no ack or outbox send ever runs for it — records stay local drafts.
  });

  it('defers the batch when the transfer ledger is unavailable', async () => {
    writeCursor(10, runsDir, () => NOW);
    const deps = seams([row(11, `PATCH-BEGIN fix-9 2 ${SHA}`), row(12, 'later text')]);
    const result = await ingestIMessages(cfg(), {
      ...deps,
      patchFrame: () => ({ handled: true, outcome: 'unavailable' as const }),
    });
    expect(result).toMatchObject({ deferred: true, ok: false });
    expect(result.patches).toMatchObject({ frames: 1 });
  });
});
