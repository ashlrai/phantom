import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const fixture = join(process.cwd(), 'test/fixtures/runs-resource-ledger');
const now = Date.parse('2026-11-02T12:00:00Z');
const roots: string[] = [];
async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claude-quota-ledger-'));
  roots.push(root);
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), await readFile(join(fixture, 'status.json')));
  return root;
}
const reading = (over: Record<string, unknown> = {}, pct = 61) => ({
  v: 1, observedAt: '2026-11-02T11:55:00Z', reason: 'observed', fresh: true,
  windows: [
    { id: 'seven_day', usedPct: pct, resetAt: '2026-11-07T16:02:00Z' },
    { id: 'seven_day_fable', usedPct: 100, resetAt: '2026-11-07T16:02:00Z' },
    { id: 'five_hour', usedPct: 3, resetAt: '2026-11-02T15:00:00Z' },
  ], ...over,
});
const put = (root: string, value: unknown) => writeFile(join(root, 'metrics/claude-quota.json'), JSON.stringify(value));
const claudeLane = async (root: string) => {
  const ledger = await readResourceLedger({ runsDir: root, now: () => now, personalCodexHome: join(root, 'none') });
  return { ledger, lane: ledger.lanes.find(l => l.lane === 'claude')! };
};
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });

describe('claude native quota in the resource ledger', () => {
  it('replaces the stale status value and carries per-model scopes', async () => {
    const root = await setup();
    await put(root, reading());
    const { lane } = await claudeLane(root);
    expect(lane).toMatchObject({ usedPct: 61, resetAt: '2026-11-07T16:02:00Z', source: 'claude-native-usage',
      observation: { source: 'claude-native-usage', asOf: '2026-11-02T11:55:00Z' } });
    expect(lane.quotaEvidence).toMatchObject({ state: 'observed-headroom', reason: 'measured-quota' });
    expect(lane.quotaScopes).toEqual([{ id: 'seven_day_fable', usedPct: 100, resetAt: '2026-11-07T16:02:00Z' }]);
  });
  it('reports exhausted at 100%', async () => {
    const root = await setup();
    await put(root, reading({}, 100));
    expect((await claudeLane(root)).lane.quotaEvidence?.state).toBe('exhausted');
  });
  it.each([
    ['a reading over 6 hours old', reading({ observedAt: '2026-11-02T04:59:00Z' })],
    ['a not-fresh reading', reading({ fresh: false, windows: [] })],
    ['a future reading', reading({ observedAt: '2026-11-02T13:00:00Z' })],
    ['a reading with no seven_day window', reading({ windows: [{ id: 'five_hour', usedPct: 3, resetAt: null }] })],
  ])('leaves the row unchanged for %s', async (_name, value) => {
    const root = await setup();
    const before = (await claudeLane(root)).lane;
    await put(root, value);
    const { lane, ledger } = await claudeLane(root);
    expect(lane).toEqual(before);
    expect(lane.usedPct).toBe(70);
    expect(ledger.sources.status).toBe('healthy');
  });
  it('ignores corrupt and symlinked files without degrading sources', async () => {
    const root = await setup();
    const before = await claudeLane(root);
    await writeFile(join(root, 'metrics/claude-quota.json'), '{nope');
    expect(await claudeLane(root)).toEqual(before);
    await rm(join(root, 'metrics/claude-quota.json'));
    await writeFile(join(root, 'real.json'), JSON.stringify(reading()));
    await symlink(join(root, 'real.json'), join(root, 'metrics/claude-quota.json'));
    const after = await claudeLane(root);
    expect(after.lane).toEqual(before.lane);
    expect(after.ledger.sources).toEqual(before.ledger.sources);
  });
});
