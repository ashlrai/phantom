import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { listCosDrafts } from '../src/core/cos/drafts.js';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

let runsDir = '';
const key = (n: number) => n.toString(16).repeat(64).slice(0, 64);
async function draft(n: number, channel: ChannelEnvelope['channel'] = 'telegram', text = `Reply ${n}.`) {
  const id = await queueCosEnvelope({ channel, verifiedSenderId: `${channel}:fake-${n}`, body: `task ${n}`,
    receivedAt: '2026-11-01T12:00:00.000Z', dedupeKey: key(n), ...(channel === 'telegram' ? { threadId: `${n}` } : {}) }, runsDir);
  const d = await draftCosResult(id, text, runsDir);
  // Fixed, distinct mtimes make newest-first ordering deterministic.
  const at = new Date(Date.UTC(2026, 10, 1, 12, n));
  utimesSync(join(runsDir, 'cos', `${id}.json`), at, at);
  return d;
}

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'cos-drafts-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('listCosDrafts', () => {
  it('returns an empty list when the cos directory is missing', async () => {
    expect(await listCosDrafts({ runsDir })).toEqual({ v: 1, drafts: [], malformed: 0 });
    expect(await listCosDrafts({ runsDir: join(runsDir, 'nope') })).toEqual({ v: 1, drafts: [], malformed: 0 });
  });

  it('lists drafts newest first with origin, digest, mtime and delivery state', async () => {
    const pending = await draft(1);
    const sent = await draft(2, 'email');
    const uncertain = await draft(3);
    await deliverCosResult(sent.id, sent.digest, async () => {}, runsDir);
    await expect(deliverCosResult(uncertain.id, uncertain.digest, async () => { throw new Error('fake failure'); }, runsDir)).rejects.toThrow();
    const list = await listCosDrafts({ runsDir });
    expect(list.malformed).toBe(0);
    expect(list.drafts.map(d => [d.id, d.delivery])).toEqual([[uncertain.id, 'uncertain'], [sent.id, 'sent'], [pending.id, 'pending']]);
    expect(list.drafts[2]).toEqual({ id: pending.id, channel: 'telegram', senderId: 'telegram:fake-1', threadId: '1',
      text: 'Reply 1.', digest: pending.digest, delivery: 'pending', draftedAt: '2026-11-01T12:01:00.000Z' });
    expect(list.drafts[1]).not.toHaveProperty('threadId');
  });

  it('reports a sending claim and treats an unreadable claim as uncertain, never pending', async () => {
    const a = await draft(1);
    const b = await draft(2);
    writeFileSync(join(runsDir, 'cos', `${a.id}.delivery.json`), JSON.stringify({ state: 'sending' }));
    writeFileSync(join(runsDir, 'cos', `${b.id}.delivery.json`), '{broken');
    const list = await listCosDrafts({ runsDir });
    expect(Object.fromEntries(list.drafts.map(d => [d.id, d.delivery]))).toEqual({ [a.id]: 'sending', [b.id]: 'uncertain' });
  });

  it('skips and counts malformed drafts; ignores delivery files and foreign names', async () => {
    const good = await draft(1);
    const dir = join(runsDir, 'cos');
    writeFileSync(join(dir, `cos-${'b'.repeat(32)}.json`), '{not json');
    // id field disagrees with the file name
    writeFileSync(join(dir, `cos-${'c'.repeat(32)}.json`), JSON.stringify({ id: `cos-${'d'.repeat(32)}`, origin: { channel: 'cli', senderId: 'x' }, text: 'x', digest: 'e'.repeat(64) }));
    writeFileSync(join(dir, `cos-${'f'.repeat(32)}.json`), JSON.stringify({ id: `cos-${'f'.repeat(32)}`, origin: { channel: 'cli', senderId: 'x' }, text: 'x', digest: 'short' }));
    mkdirSync(join(dir, `cos-${'a'.repeat(32)}.json`));
    writeFileSync(join(dir, 'notes.json'), '{}');
    writeFileSync(join(dir, `cos-${'9'.repeat(32)}.delivery.json`), JSON.stringify({ state: 'sent' }));
    const list = await listCosDrafts({ runsDir });
    expect(list.drafts.map(d => d.id)).toEqual([good.id]);
    expect(list.malformed).toBe(4);
  });

  it('applies the default, explicit and maximum limits', async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 4; n++) ids.push((await draft(n)).id);
    expect((await listCosDrafts({ runsDir, limit: 2 })).drafts.map(d => d.id)).toEqual([ids[3], ids[2]]);
    expect((await listCosDrafts({ runsDir, limit: 0 })).drafts).toHaveLength(1);
    expect((await listCosDrafts({ runsDir, limit: 10_000 })).drafts).toHaveLength(4);
    expect((await listCosDrafts({ runsDir })).drafts).toHaveLength(4);
  });

  it('is read-only', async () => {
    await draft(1);
    const before = readdirSync(join(runsDir, 'cos')).sort();
    await listCosDrafts({ runsDir });
    expect(readdirSync(join(runsDir, 'cos')).sort()).toEqual(before);
  });
});
