import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sendOwnerPlanReply } from '../src/core/comms/owner-reply.js';
import { readOwnerThread, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { readPlanLogReplies } from '../src/core/fleet/mason-outbox.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'plan-thread-')); roots.push(runsDir);
  const leader = join(runsDir, 'leader'); mkdirSync(leader);
  const planLog = join(leader, 'PLAN-LOG.md');
  writeFileSync(planLog, '## 2026-11-21 10:00 ET leader pass\n**Reply for Mason**: "Update ready.\nAll quiet."\n');
  const deliver = vi.fn(async (): Promise<{ status: 'sent' | 'duplicate' | 'refused'; reason: string }> => ({ status: 'sent', reason: 'ok' }));
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'),
    settings: { owners: { imessage: 'synthetic-owner' }, secretHandles: {}, imessageBridge: 'loopback', confirmed: true, team: [{ channel: 'imessage', id: 'synthetic-owner' }] },
    transports: { imessage: { pull: async () => [], deliver } },
  };
  const state = join(leader, 'owner-reply.json');
  const thread = () => readOwnerThread(options).messages;
  const run = (input: { dryRun?: boolean } = {}) => sendOwnerPlanReply(options, { ...input, planLog });
  const setState = async (value: 'sent' | 'pending') => {
    const reply = (await readPlanLogReplies({ file: planLog, limit: 1, fileOrder: true })).entries[0]!;
    writeFileSync(state, JSON.stringify({ [reply.id]: value }));
  };
  return { options, deliver, state, thread, run, setState, leader };
}

it('records the sent text once on desktop and deduplicates subsequent calls', async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({ status: 'sent', mirror: { status: 'recorded' } });
  expect(f.thread()).toMatchObject([{ direction: 'outbound', channel: 'desktop', fanout: ['desktop'], text: 'Update ready.\nAll quiet.' }]);
  expect(f.deliver.mock.calls).toHaveLength(1);
  expect(await f.run()).toMatchObject({ status: 'duplicate', mirror: { status: 'duplicate' } });
  expect(f.thread()).toHaveLength(1);
  expect(f.deliver).toHaveBeenCalledTimes(1);
});

it('repairs an existing sent record without invoking the transport', async () => {
  const f = fixture(); await f.setState('sent');
  expect(await f.run()).toMatchObject({ status: 'duplicate', mirror: { status: 'recorded' } });
  expect(f.thread()).toHaveLength(1);
  expect(f.deliver).not.toHaveBeenCalled();
});

it('preserves sent state on mirror failure and repairs it on retry', async () => {
  const f = fixture();
  writeFileSync(join(f.leader, 'owner-thread.json'), 'invalid');
  expect(await f.run()).toMatchObject({ status: 'sent', mirror: { status: 'failed' } });
  expect(Object.values(JSON.parse(readFileSync(f.state, 'utf8')))).toEqual(['sent']);
  rmSync(join(f.leader, 'owner-thread.json'));
  expect(await f.run()).toMatchObject({ status: 'duplicate', mirror: { status: 'recorded' } });
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.thread()).toHaveLength(1);
});

it('records a transport duplicate as sent without claiming a remote thread fanout', async () => {
  const f = fixture(); f.deliver.mockResolvedValueOnce({ status: 'duplicate', reason: 'already delivered' });
  expect(await f.run()).toMatchObject({ status: 'sent', mirror: { status: 'recorded' } });
  expect(f.thread()[0]).toMatchObject({ channel: 'desktop', fanout: ['desktop'] });
});

it('never mirrors refused, uncertain, pending, previewed, unconfirmed or held sends', async () => {
  const refused = fixture(); refused.deliver.mockResolvedValueOnce({ status: 'refused', reason: 'no' });
  expect((await refused.run()).status).toBe('blocked'); expect(refused.thread()).toEqual([]);
  const thrown = fixture(); thrown.deliver.mockRejectedValueOnce(new Error('unavailable'));
  expect((await thrown.run()).status).toBe('blocked'); expect((await thrown.run()).status).toBe('blocked');
  expect(thrown.deliver).toHaveBeenCalledTimes(1); expect(thrown.thread()).toEqual([]);
  const pending = fixture(); await pending.setState('pending');
  expect((await pending.run()).status).toBe('blocked'); expect(pending.thread()).toEqual([]); expect(pending.deliver).not.toHaveBeenCalled();
  const preview = fixture(); expect((await preview.run({ dryRun: true })).status).toBe('dry-run'); expect(preview.thread()).toEqual([]);
  await preview.setState('sent'); expect((await preview.run({ dryRun: true })).status).toBe('duplicate'); expect(preview.thread()).toEqual([]);
  const unconfirmed = fixture(); unconfirmed.options.settings.confirmed = false;
  expect((await unconfirmed.run()).status).toBe('blocked'); expect(unconfirmed.thread()).toEqual([]);
  const held = fixture(); held.options.paused = true;
  expect((await held.run()).status).toBe('blocked'); expect(held.thread()).toEqual([]);
});
