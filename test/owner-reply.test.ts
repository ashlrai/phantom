import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdOwnerReply } from '../src/cli/owner-reply.js';
import { cmdFleetOwnerLive } from '../src/cli/fleet-owner-live.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-reply-')); roots.push(runsDir);
  mkdirSync(join(runsDir, 'leader'));
  const file = join(runsDir, 'leader', 'PLAN-LOG.md');
  writeFileSync(file, [1, 2, 3].map(n => `## 2026-11-21 ET, Opus leader pass ${n}\n**Reply for Mason**: "Update ${n}\nAll quiet."\n`).join('\n'));
  const deliver = vi.fn(async () => ({ status: 'sent' as const, reason: 'sent' }));
  const options: OwnerThreadOptions = { runsDir, settings: { owners: { imessage: 'owner-one' }, secretHandles: {}, imessageBridge: 'loopback', confirmed: true, team: [{ channel: 'imessage', id: 'owner-one' }] }, transports: { imessage: { pull: async () => [], deliver } } };
  const out: string[] = [];
  return { file, options, deliver, out, run: (args: string[] = []) => cmdOwnerReply(args, options, t => out.push(t)) };
}
it('previews whole newest quote without writing, sends once, then dedupes across the cycle', async () => {
  const f = fixture();
  expect(await f.run(['--dry-run', '--json', '--plan-log', f.file])).toBe(0);
  expect(JSON.parse(f.out[0]!)).toMatchObject({ status: 'dry-run', text: 'Update 3\nAll quiet.' });
  expect(existsSync(join(f.options.runsDir, 'leader', 'owner-reply.json'))).toBe(false);
  expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.run()).toBe(0); expect(await f.run()).toBe(0);
  await cmdFleetOwnerLive(['--apply', '--json'], { options: f.options, output: () => {} });
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ text: 'Update 3\nAll quiet.', ownerId: 'owner-one' }));
});
it('sends nothing without a verified pairing or with a disabled channel', async () => {
  const f = fixture(); f.options.settings.owners = {};
  expect(await f.run()).toBe(1); expect(f.out[0]).toBe('no paired owner handle; run phm owner pair');
  f.options.settings.owners.imessage = 'owner-one'; f.options.settings.imessageBridge = 'off';
  expect(await f.run()).toBe(1); expect(f.deliver).not.toHaveBeenCalled();
});
it('fails closed on unreadable state and rejects extra CLI arguments', async () => {
  const f = fixture(); writeFileSync(join(f.options.runsDir, 'leader', 'owner-reply.json'), 'broken');
  expect(await f.run()).toBe(1); expect(await f.run(['--extra'])).toBe(2);
  expect(f.deliver).not.toHaveBeenCalled();
});
it('uses the entry heading rather than the text and holds an uncertain send', async () => {
  const f = fixture(); await f.run();
  appendFileSync(f.file, '\n## 2026-11-21 04:00 ET, Opus leader pass four\n**Reply for Mason**: "Update 3\nAll quiet."\n');
  f.deliver.mockRejectedValueOnce(new Error('bridge stopped'));
  expect(await f.run()).toBe(1); expect(await f.run()).toBe(1); expect(f.deliver).toHaveBeenCalledTimes(2);
});
it('refuses ambiguous owner bindings', () => {
  const f = fixture(); writeFileSync(join(f.options.runsDir, 'agent-network.toml'), '[mason]\nidentities = [{ channel = "imessage", id = "owner-one" }, { channel = "imessage", id = "owner-two" }]\n');
  expect(loadOwnerThreadSettings(f.options.runsDir).owners.imessage).toBeUndefined();
});
