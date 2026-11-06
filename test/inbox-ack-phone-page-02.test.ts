import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acknowledgeInboxEntries } from '../src/core/fleet/inbox-ack.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const at = '2026-11-02T12:00:00Z';
const line = (channel: string, id: string) => `${at} [src:${channel} id:${id}] Please steer the fleet`;
let base = '';
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'inbox-ack-pp-'));
  vi.stubEnv('HOME', base);
  vi.stubEnv('ASHLR_HOME', join(base, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

const runs = () => join(base, 'runs');
const rows = () => readFileSync(join(runs(), 'queue', 'inbox-acks.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
const busBodies = () => {
  const page = listBusInboxAfter(0, 100);
  return page.status === 'ok' ? page.messages.map(m => m.envelope) : [];
};

it('acks phone and page entries on the bus to mason, once', async () => {
  const entries = [line('phone', 'p1'), line('page', 'g1')];
  await acknowledgeInboxEntries(entries, runs(), at);
  const sent = busBodies();
  expect(sent).toHaveLength(2);
  expect(sent.every(m => m.to === 'mason' && (m.body as { kind: string }).kind === 'inbox-ack')).toBe(true);
  expect(sent.map(m => (m.body as { channel: string }).channel).sort()).toEqual(['page', 'phone']);
  expect(rows().map(r => r.status)).toEqual(['acked', 'acked']);

  await acknowledgeInboxEntries(entries, runs(), at);
  expect(busBodies()).toHaveLength(2);
  expect(rows()).toHaveLength(2);
});

it('still skips unknown channels without posting', async () => {
  await acknowledgeInboxEntries([line('zzz', 'u1')], runs(), at);
  expect(busBodies()).toHaveLength(0);
  expect(rows()).toEqual([{ entryId: 'u1', status: 'skipped', reason: 'channel has no sender' }]);
});
