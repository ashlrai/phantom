import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: () => ({}) }));
vi.mock('../src/core/integrations/imessage.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/integrations/imessage.js')>(),
  commsEnabled: () => true, readLastSend: () => ({ ok: true, at: '2026-11-13T17:59:30.000Z' }),
}));
vi.mock('node:child_process', () => ({ execFile: (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null) => void) => cb(null) }));

import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const old = '2026-11-13T16:00:00.000Z';
const recent = '2026-11-13T17:55:00.000Z';
const later = '2026-11-13T17:59:00.000Z';
const future = '2026-11-13T18:01:00.000Z';
const slack: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
const dirs: string[] = [];
const row = (rowid: number, at: string, status: 'accepted' | 'duplicate') => ({ rowid, at, status });
async function setup(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'imessage-replay-'));
  dirs.push(dir);
  await mkdir(join(dir, 'imessage'));
  if (content !== undefined) await writeFile(join(dir, 'imessage', 'acks.jsonl'), content);
  const source = defaultChannelSources(dir).imessage;
  const report = async () => (await readChannelHealth({ now: () => now, host: 'fake', runsDir: dir, sources: { slack, imessage: source } })).channels[1]!;
  return { dir, source, report };
}
const journal = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('iMessage replay observations', () => {
  it('keeps the latest replay per rowid and counts distinct requests', async () => {
    const { source, report } = await setup(journal(row(1, old, 'accepted'), row(1, recent, 'duplicate'),
      row(1, later, 'duplicate'), row(2, recent, 'duplicate')));
    expect(await source.inbound(now)).toEqual([later, recent]);
    const channel = await report();
    expect(channel).toMatchObject({ lastInboundAt: later, unansweredCount: 2,
      proof: { requestCoverage: 'unproven', futureDatedCount: 0 } });
    expect(channel.proof.answeredCount).toBeUndefined();
    expect(channel.proof.durableIngress).toBeUndefined();
  });

  it('retains a current accepted observation when a replay is future dated', async () => {
    const { report } = await setup(journal(row(1, recent, 'accepted'), row(1, future, 'duplicate')));
    expect(await report()).toMatchObject({ state: 'UNKNOWN', lastInboundAt: recent, unansweredCount: 1,
      proof: { requestCoverage: 'unproven', futureDatedCount: 1 } });
  });

  it('reports a missing or unreadable journal as unknown', async () => {
    const { dir, report } = await setup();
    expect(await report()).toMatchObject({ state: 'UNKNOWN', missing: ['imessage inbound journal missing'] });
    await symlink(join(dir, 'missing'), join(dir, 'imessage', 'acks.jsonl'));
    expect(await report()).toMatchObject({ state: 'UNKNOWN', missing: ['imessage receipt source unreadable'] });
  });

  it('retains valid replay activity while reporting malformed coverage', async () => {
    const { report } = await setup(journal(row(1, recent, 'duplicate')) + 'bad\n');
    expect(await report()).toMatchObject({ state: 'UNKNOWN', lastInboundAt: recent, unansweredCount: 1,
      missing: ['imessage receipt source unreadable'], proof: { requestCoverage: 'unproven' } });
  });
});
