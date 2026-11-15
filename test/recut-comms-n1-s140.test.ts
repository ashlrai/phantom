/**
 * RQ-PHX-RECUTCOMMSN1S140 recut coverage for #4966 (RQ-PHX-RECUTCOMMSO1S126,
 * itself a recut of #4073 / RQ-SWE3-IMSGDEEP-1) on current master. The carried
 * suites (imessage-patch-transfer.test.ts, .recut-s126o.test.ts) cover the
 * protocol, the leaf placement and the watermark; this file pins the two facts
 * this recut must guarantee:
 *
 *   - The recovered intake wiring works end to end through the real exported
 *     entry point: PATCH frames are consumed by the durable transfer ledger,
 *     never mirrored as findings, and a verified artifact is announced once.
 *   - The outside-send gate is untouched: a non-Mason outside recipient still
 *     gets a draft (or a refusal), never a send, while comms.toml lacks
 *     confirmedByMason — and the native transport never runs.
 *
 * Hermetic: node:child_process is mocked, HOME/runsDir/bus roots are tmp dirs,
 * handles are plainly fake contacts, and asserts never print text or handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: runner };
});

import { checkSendPolicy } from '../src/core/agents/channel-policy.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { bridgeTeammateFindings, TEAMMATE_FINDINGS_TOPIC } from '../src/core/comms/imessage-findings-bridge.js';
import { isPatchFrameText, senderIdFor, teammateNeedsReply } from '../src/core/comms/imessage-teammate-inbox.js';
import { approvedTeammateHandle, sendApprovedTeammateMessage } from '../src/core/comms/imessage-teammate-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = '+15550000001';
const TEAMMATE = '+15550000000';
const OUTSIDER = 'someone@example.com';
const NOW = new Date('2026-11-11T12:00:00Z');
const BODY = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
const SHA = createHash('sha256').update(BODY, 'utf8').digest('hex');

const cfg = (): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON, TEAMMATE] } }) as AshlrConfig;
const row = (rowid: number, text: string, handle = TEAMMATE): IntakeMsg => ({ rowid, handle, text, ts: 1 });

let home = '';
let runsDir = '';
let busRoot = '';
let configDir = '';
let previousHome: string | undefined;
let platform: PropertyDescriptor;

const imsgDir = () => join(runsDir, 'imessage');
const busEnvelopes = () => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map((m) => m.envelope) : [];
};

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'recut-n1s140-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'recut-n1s140-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'recut-n1s140-bus-'));
  configDir = mkdtempSync(join(tmpdir(), 'recut-n1s140-cfg-'));
  process.env['HOME'] = home;
  mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
  writeCursor(10, runsDir, () => NOW);
  runner.mockReset();
  runner.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => cb(null, '', ''));
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe('recovered patch-transfer intake (from #4966)', () => {
  it('consumes PATCH frames at intake and announces the verified artifact once', async () => {
    const result = await ingestIMessages(cfg(), {
      runsDir, busRoot, now: () => NOW, platform: 'darwin',
      poll: async () => ({
        ok: true,
        messages: [
          row(11, `PATCH-BEGIN fix-1 1 ${SHA}`),
          row(12, `PATCH-PART fix-1 1/1\n${BODY}`),
          row(13, `PATCH-END fix-1 ${SHA}`),
          row(14, 'can you check the gate?'),
        ],
      }),
    });
    expect(result).toMatchObject({ ok: true, state: 'ingested', teammate: 4 });
    expect(result.patches).toMatchObject({ frames: 3, completed: 1, rejected: 0, refused: 0 });
    expect(result.findings).toMatchObject({ protocol: 3, announced: 1 });
    expect(existsSync(join(imsgDir(), 'patches', 'fix-1.patch'))).toBe(true);
    expect(readFileSync(join(imsgDir(), 'patches', 'fix-1.patch'), 'utf8')).toBe(BODY);
    // One metadata-only note on the findings topic; never the patch body.
    const notes = busEnvelopes().filter((e) => e.id === 'imessage-patch-fix-1');
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).not.toContain('diff --git');
    // The conversational text is still mirrored as an ordinary finding.
    expect(busEnvelopes().some((e) => e.id === 'imessage-teammate-14' && e.to === TEAMMATE_FINDINGS_TOPIC)).toBe(true);
    // A second pass never re-announces.
    expect(bridgeTeammateFindings({ runsDir, busRoot, now: () => NOW })).toMatchObject({ announced: 0 });
  });

  it('marks protocol frames as never needing a reply', () => {
    expect(isPatchFrameText(`PATCH-BEGIN fix-1 1 ${SHA}`)).toBe(true);
    expect(teammateNeedsReply(`PATCH-BEGIN fix-1 1 ${SHA}`)).toBe(false);
    expect(teammateNeedsReply('PATCH-PART fix-1 1/1\nchunk')).toBe(false);
    expect(teammateNeedsReply('can you check the gate?')).toBe(true);
  });
});

describe('outside sends stay drafts (hard limit)', () => {
  it('policy: a team recipient without confirmedByMason is drafted, never sent', () => {
    const teamId = senderIdFor(TEAMMATE);
    const decision = checkSendPolicy({
      channel: 'imessage', recipients: [teamId], external: false,
      teamIdentities: [{ channel: 'imessage', id: teamId }],
      confirmedByMason: false,
    });
    expect(decision.status).toBe('drafted');
    // A truly outside recipient — not a team identity — is refused outright.
    const outside = checkSendPolicy({
      channel: 'imessage', recipients: [senderIdFor(OUTSIDER)], external: false,
      teamIdentities: [{ channel: 'imessage', id: teamId }],
      confirmedByMason: false,
    });
    expect(outside.status).toBe('refused');
  });

  it('transport: an unconfirmed outside message never reaches osascript', async () => {
    const sender = senderIdFor(TEAMMATE);
    writeFileSync(join(configDir, 'agent-network.toml'),
      `[team]\nidentities = [{ channel = "imessage", id = "${sender}" }]\n`, { mode: 0o600 });
    // comms.toml exists but Mason has not confirmed it — the drafts gate.
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = false\n', { mode: 0o600 });
    expect(approvedTeammateHandle(sender, cfg(), { configDir, loadConfig: cfg })).toBeNull();
    expect(await sendApprovedTeammateMessage('draft reply', sender, cfg(), { configDir, loadConfig: cfg })).toBe('refused');
    // No message file, no AppleScript: nothing was sent.
    expect(runner).not.toHaveBeenCalled();
  });
});
