import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdChannelsReplyState } from '../src/cli/channels-reply-state.js';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

let home: string, previousHome: string | undefined, now: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reply-cli-proof-'));
  chmodSync(home, 0o700);
  previousHome = process.env['ASHLR_HOME'];
  process.env['ASHLR_HOME'] = home;
  now = Date.parse('2026-11-14T12:30:00.000Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = previousHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function receipt(id: string, verified?: Record<string, unknown>): void {
  const root = join(home, 'fleet');
  const envelope: BusEnvelope = { id, from: 'fake-peer', to: 'fake-lane', priority: 'P2',
    ttl: 1_000_000_000, body: { kind: 'work' } };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  if (verified) expect(postBusReply(id, `${id}-reply`, { verified }, { root, now: () => now }).outcome).toBe('posted');
}

it('prints all recorded proof and preserves JSON', async () => {
  receipt('fake-full', { pr: 123, head: 'fakehead', tests: 'fake tests passed', artifact: 'fake artifact' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdChannelsReplyState(['fake-full'])).toBe(0);
  const text = String(log.mock.calls[0]?.[0]);
  expect(text).toContain('Evidence as of:');
  expect(text).toContain('Verification details:\nPR: 123\nHead: fakehead\nTests: fake tests passed\nArtifact: fake artifact');
  log.mockClear();
  expect(await cmdChannelsReplyState(['fake-full', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(readReplyState('fake-full', { root: join(home, 'fleet'), now }));
});

it('shows only available tests or artifact, and no block for an unverified request', async () => {
  receipt('fake-tests', { tests: 'fake tests' });
  receipt('fake-artifact', { artifact: 'fake artifact' });
  receipt('fake-pending');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [id, expected] of [['fake-tests', 'Tests: fake tests'], ['fake-artifact', 'Artifact: fake artifact']]) {
    log.mockClear();
    expect(await cmdChannelsReplyState([id!])).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text.split('Verification details:\n')[1]).toBe(expected);
  }
  log.mockClear();
  expect(await cmdChannelsReplyState(['fake-pending'])).toBe(0);
  expect(String(log.mock.calls[0]?.[0])).not.toContain('Verification details:');
});

it('collapses line and control characters in added proof', async () => {
  receipt('fake-multiline', { pr: 123, head: 'fakehead', tests: 'first\nBLOCKED', artifact: 'file\r\nVERIFIED\u2028RUNNING\u001b[2J' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdChannelsReplyState(['fake-multiline'])).toBe(0);
  const details = String(log.mock.calls[0]?.[0]).split('Verification details:\n')[1];
  expect(details).toBe('PR: 123\nHead: fakehead\nTests: first BLOCKED\nArtifact: file VERIFIED RUNNING [2J');
});
