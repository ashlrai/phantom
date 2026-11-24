/** RQ-IMSGONN22XQ8: iMessage turns on with no human step; nothing is sent without a verified Mason handle. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetOwnerLive } from '../src/cli/fleet-owner-live.js';
import { ensureOwnerAdaptersFile, setImessageBridge } from '../src/core/comms/owner-adapters-file.js';
import { emptyOwnerSettings, loadOwnerThreadSettings, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { sendLeaderReplyToPhone } from '../src/core/comms/owner-live-reply.js';
import { readOwnerLiveStatus } from '../src/core/comms/owner-live-status.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'imsg-on-')); roots.push(d); return d; };
const adapters = (dir: string): string => join(dir, 'comms', 'owner-adapters.toml');
const none = { halted: false, paused: false };

describe('owner-adapters.toml starter', () => {
  it('writes iMessage loopback and no secret-shaped text when the file is missing', () => {
    const dir = tmp();
    expect(ensureOwnerAdaptersFile(dir).created).toBe(true);
    const text = readFileSync(adapters(dir), 'utf8');
    expect(text).toContain('[imessage]\n');
    expect(loadOwnerThreadSettings(dir).imessageBridge).toBe('loopback');
    for (const c of ['telegram', 'email', 'slack']) expect(text).toContain(`[${c}]`);
    expect(text.split('\n').filter(l => l.includes('secretHandle')).every(l => l.startsWith('#'))).toBe(true);
    expect(text).not.toMatch(/\d{5,}|@|https?:|[A-Za-z0-9]{32,}/);
    expect(loadOwnerThreadSettings(dir).secretHandles).toEqual({});
  });

  it('leaves an existing file untouched', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'comms'));
    writeFileSync(adapters(dir), '# mine\n');
    expect(ensureOwnerAdaptersFile(dir).created).toBe(false);
    expect(readFileSync(adapters(dir), 'utf8')).toBe('# mine\n');
  });

  it('enable and disable flip only the bridge key', () => {
    const dir = tmp();
    ensureOwnerAdaptersFile(dir);
    const before = readFileSync(adapters(dir), 'utf8');
    expect(setImessageBridge(dir, false).changed).toBe(true);
    const off = readFileSync(adapters(dir), 'utf8');
    expect(off).toBe(before.replace('bridge = "loopback"', 'bridge = "off"'));
    expect(loadOwnerThreadSettings(dir).imessageBridge).toBe('off');
    expect(setImessageBridge(dir, true).changed).toBe(true);
    expect(readFileSync(adapters(dir), 'utf8')).toBe(before);
    expect(setImessageBridge(dir, true).changed).toBe(false);
  });

  it('enable adds the section to a file that lacks it, keeping other lines', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'comms'));
    writeFileSync(adapters(dir), '[slack]\n# keep me\n');
    setImessageBridge(dir, true);
    const text = readFileSync(adapters(dir), 'utf8');
    expect(text).toContain('[slack]\n# keep me\n');
    expect(loadOwnerThreadSettings(dir).imessageBridge).toBe('loopback');
  });

  it('the CLI creates the starter on --apply only, and enable/disable report json', async () => {
    const dir = tmp();
    const out: string[] = [];
    const deps = { configDir: dir, output: (t: string) => out.push(t), error: () => undefined };
    expect(await cmdFleetOwnerLive(['disable', 'imessage', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ channel: 'imessage', bridge: 'off', changed: true });
    expect(await cmdFleetOwnerLive(['enable', 'telegram'], deps)).toBe(2);
  });
});

function fixture(settings: OwnerThreadSettings) {
  const runsDir = tmp();
  const sent: string[] = [];
  const options: OwnerThreadOptions = {
    runsDir, settings, now: () => 1_700_000_000_000,
    transports: { imessage: { async pull() { return []; }, async deliver(i) { sent.push(i.ownerId); return { status: 'sent', reason: 'sent' }; } } },
  };
  return { options, sent };
}
const replies = [{ at: '2026-11-21 07:00', text: 'All quiet.', source: 'plan-log' as const }];

describe('iMessage on: who gets the reply', () => {
  it('plans exactly one send with a verified binding and a new reply', async () => {
    const { options, sent } = fixture({ ...emptyOwnerSettings(), owners: { imessage: 'mason-handle' }, imessageBridge: 'loopback', confirmed: true, team: [{ channel: 'imessage', id: 'mason-handle' }] });
    const plan = await sendLeaderReplyToPhone(options, { apply: false, replies, ...none });
    expect(plan).toMatchObject({ reason: 'planned', planned: ['imessage'] });
    const done = await sendLeaderReplyToPhone(options, { apply: true, replies, ...none });
    expect(done.sent).toEqual(['imessage']);
    expect(sent).toEqual(['mason-handle']);
  });

  it('sends nothing and says why when there is no Mason binding', async () => {
    const settings = { ...emptyOwnerSettings(), imessageBridge: 'loopback' as const, confirmed: true };
    const { options, sent } = fixture(settings);
    const result = await sendLeaderReplyToPhone(options, { apply: true, replies, ...none });
    expect(result.reason).toBe('no-channel-on');
    expect(sent).toEqual([]);
    expect(result.skipped.find(s => s.channel === 'imessage')?.reason).toContain('iMessage on, but no verified Mason handle: run phm owner pair imessage');
    const row = readOwnerLiveStatus(settings, none).channels.find(c => c.channel === 'imessage');
    expect(row?.reason).toBe('iMessage on, but no verified Mason handle: run phm owner pair imessage');
  });
});
