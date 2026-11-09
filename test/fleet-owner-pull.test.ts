import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetOwnerPull } from '../src/cli/fleet-owner-pull.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { OWNER_SECRET_HANDLES, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { readOwnerThread, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-pull-'));
  roots.push(runsDir);
  const makeTransport = (senderId: string, idempotencyKey: string): OwnerChannelTransport => ({
    pull: vi.fn(async () => [{ senderId, idempotencyKey, text: `private ${idempotencyKey}`, at: 1_700_000_000_000 }]),
    deliver: vi.fn(async () => ({ status: 'sent', reason: 'ok' })),
  });
  const transports = {
    telegram: makeTransport('owner-test-1', 'telegram-message-1'),
    slack: makeTransport('U0TEST', 'slack-message-001'),
    email: makeTransport('unused', 'email-message-001'),
    imessage: makeTransport('unused', 'imessage-message-1'),
  };
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => 1_700_000_000_000,
    settings: { owners: { telegram: 'owner-test-1', slack: 'U0TEST' }, secretHandles: { ...OWNER_SECRET_HANDLES }, imessageBridge: 'off', confirmed: true, team: [
      { channel: 'telegram', id: 'owner-test-1' }, { channel: 'slack', id: 'U0TEST' },
    ] },
    transports,
    mailbox: { accept: async () => ({ status: 'accepted' }) },
  };
  const output: string[] = [];
  const error: string[] = [];
  const run = (args: string[] = []) => cmdFleetOwnerPull(args, { options, output: line => output.push(line), error: line => error.push(line) });
  return { options, transports, output, error, run };
}

it('pulls sequentially, skips unconfigured channels, and deduplicates on retry', async () => {
  const f = fixture();
  expect(await f.run(['--json'])).toBe(0);
  const first = JSON.parse(f.output[0]!);
  expect(first.channels.map((row: { channel: string; pulled: boolean; accepted: number }) => [row.channel, row.pulled, row.accepted])).toEqual([
    ['telegram', true, 1], ['slack', true, 1], ['email', false, 0], ['imessage', false, 0],
  ]);
  expect(first.channels[2].nextStep).toBeTruthy();
  expect(first.channels[3].nextStep).toBeTruthy();
  expect(f.transports.email.pull).not.toHaveBeenCalled();
  expect(f.transports.imessage.pull).not.toHaveBeenCalled();
  expect(f.output[0]).not.toContain('private');
  expect(readOwnerThread(f.options).messages.map(m => m.channel)).toEqual(['telegram', 'slack']);
  expect(await f.run(['--json'])).toBe(0);
  expect(JSON.parse(f.output[1]!).channels.slice(0, 2).map((row: { duplicate: number }) => row.duplicate)).toEqual([1, 1]);
});

it('restricts the pass to the selected channel and emits counts', async () => {
  const f = fixture();
  expect(await f.run(['--channel', 'telegram'])).toBe(0);
  expect(f.output).toEqual(['telegram: 1/0/0 new/dup/refused']);
  expect(f.transports.slack.pull).not.toHaveBeenCalled();
});

it('continues after an unavailable transport', async () => {
  const f = fixture();
  vi.mocked(f.transports.telegram.pull).mockRejectedValueOnce(new Error('private transport error'));
  expect(await f.run(['--json'])).toBe(1);
  const rows = JSON.parse(f.output[0]!).channels;
  expect(rows[0].unavailable).toBe(1);
  expect(rows[1].accepted).toBe(1);
  expect(f.output[0]).not.toContain('private');
});

it('halts before calling transports and rejects bad arguments', async () => {
  const f = fixture();
  f.options.halted = true;
  expect(await f.run()).toBe(0);
  expect(f.output).toEqual(['halted']);
  expect(f.transports.telegram.pull).not.toHaveBeenCalled();
  expect(f.transports.slack.pull).not.toHaveBeenCalled();
  expect(await f.run(['--bad'])).toBe(2);
  expect(f.error).toHaveLength(1);
});

it('registers the fleet verb', () => {
  expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('owner-pull');
});
