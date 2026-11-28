import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: () => ({ comms: { enabled: true } }) }));
vi.mock('node:child_process', () => ({ execFile: (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null) => void) => cb(null) }));
import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = '2026-11-13T18:00:00.000Z';
const at = '2026-11-13T17:55:00.000Z';
const slack: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
let dir: string;
let file: string;
const receipt = (ok: boolean, time = at) => JSON.stringify({ version: 1, ok, at: time, errorCode: 'SENTINEL_PRIVATE' });
const report = async () => (await readChannelHealth({ now: () => new Date(now), host: 'fake-host', runsDir: dir,
  sources: { slack, imessage: { ...defaultChannelSources(dir).imessage, configMissing: () => [] } } })).channels[1]!;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'health-943s-'));
  mkdirSync(join(dir, 'imessage'));
  file = join(dir, 'imessage', 'last-send.json');
  writeFileSync(join(dir, 'imessage', 'acks.jsonl'), '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('iMessage outbound store coverage', () => {
  it.each([
    ['malformed JSON', '{SENTINEL_PRIVATE'],
    ['invalid shape', JSON.stringify({ version: 1, ok: 'SENTINEL_PRIVATE', at })],
    ['wrong version', JSON.stringify({ version: 2, ok: true, at })],
    ['truncated JSON', receipt(true).slice(0, -1)],
    ['oversize', 'SENTINEL_PRIVATE'.repeat(5000)],
    ['missing success timestamp', JSON.stringify({ version: 1, ok: true })],
    ['malformed success timestamp', receipt(true, 'SENTINEL_PRIVATE')],
  ])('reports %s as unreadable', async (_name, contents) => {
    writeFileSync(file, contents);
    const result = await report();
    expect(result).toMatchObject({ state: 'UNKNOWN', missing: ['imessage receipt source unreadable'] });
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PRIVATE');
  });
  it('rejects symlink evidence', async () => {
    symlinkSync(join(dir, 'imessage', 'acks.jsonl'), file);
    expect(await report()).toMatchObject({ state: 'UNKNOWN', missing: ['imessage receipt source unreadable'] });
  });
  it('keeps a missing store idle', async () => {
    expect(await report()).toMatchObject({ state: 'LIVE', lastReplyAt: null, missing: [] });
  });
  it('retains valid success and failure observations without error payloads', async () => {
    writeFileSync(file, receipt(true));
    expect(await report()).toMatchObject({ state: 'LIVE', lastReplyAt: at });
    writeFileSync(file, receipt(false));
    const result = await report();
    expect(result).toMatchObject({ state: 'DEGRADED', missing: ['imessage outbound send failed'] });
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PRIVATE');
  });
  it('uses one outbound snapshot for both observations', async () => {
    writeFileSync(file, receipt(true));
    const source = defaultChannelSources(dir).imessage;
    expect(await source.replies()).toEqual([at]);
    writeFileSync(file, receipt(false));
    expect(await source.outboundFailure!()).toBeNull();
    expect(await report()).toMatchObject({ state: 'DEGRADED' });
  });
});
