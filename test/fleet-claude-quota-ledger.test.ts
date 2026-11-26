import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import { readClaudeQuotaReading } from '../src/core/fleet/claude-quota-reading.js';

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
  it.each([null, 42, '', 'claude:ABCDEF0123456789', 'org-fixture-123', 'claude:0123456789abcdef0'])('rejects malformed persisted scope %s', async (accountId) => {
    const root = await setup();
    await put(root, reading({ accountId }));
    expect(await readClaudeQuotaReading(root)).toBeNull();
  });
  it('accepts optional opaque scope and legacy unscoped files', async () => {
    const root = await setup();
    await put(root, reading({ accountId: 'claude:0123456789abcdef' }));
    expect(await readClaudeQuotaReading(root)).toMatchObject({ accountId: 'claude:0123456789abcdef' });
    await put(root, reading());
    expect(await readClaudeQuotaReading(root)).not.toHaveProperty('accountId');
  });
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
    ['newer', '2026-11-02T11:59:00Z', 100, 'exhausted'],
    ['equal', '2026-11-02T11:55:00Z', 61, 'observed-headroom'],
    ['older', '2026-11-02T11:54:00Z', 61, 'observed-headroom'],
    ['future', '2026-11-02T12:01:00Z', 61, 'observed-headroom'],
  ])('orders native usage against a %s status quota by capture time', async (_label, observedAt, usedPct, state) => {
    const root = await setup();
    const resetAt = '2026-11-07T16:02:00Z';
    await writeFile(join(root, 'queue/status.json'), JSON.stringify({
      last_tick: '2026-11-02T12:00:00Z', lanes: { claude: { held: true } },
      budget: { claude: { weekly_used_pct: 100, observed_at: observedAt, reset_at: resetAt, source: 'dispatcher' } },
    }));
    await put(root, reading());
    const { lane } = await claudeLane(root);
    expect(lane).toMatchObject({ usedPct, resetAt, held: true, quotaEvidence: { state } });
    if (usedPct === 100) {
      expect(lane.source).toBe('dispatcher');
      expect(lane.quotaEvidence).toMatchObject({ reason: 'status-quota', measuredQuota: null, holdConflict: null });
    } else {
      expect(lane.source).toBe('claude-native-usage');
    }
  });
  it('keeps the active weekly reading and omits only model scopes whose reset has arrived', async () => {
    const root = await setup();
    await put(root, reading({ windows: [
      { id: 'seven_day', usedPct: 61, resetAt: '2026-11-07T16:02:00Z' },
      { id: 'seven_day_fable', usedPct: 100, resetAt: '2026-11-02T12:00:00Z' },
      { id: 'seven_day_opus', usedPct: 30, resetAt: '2026-11-02T12:00:01Z' },
      { id: 'seven_day_sonnet', usedPct: 20, resetAt: null },
    ] }));
    const { lane } = await claudeLane(root);
    expect(lane.usedPct).toBe(61);
    expect(lane.quotaScopes).toEqual([
      { id: 'seven_day_opus', usedPct: 30, resetAt: '2026-11-02T12:00:01Z' },
      { id: 'seven_day_sonnet', usedPct: 20, resetAt: null },
    ]);
  });
  it.each([
    ['a reading over 6 hours old', reading({ observedAt: '2026-11-02T04:59:00Z' })],
    ['a not-fresh reading', reading({ fresh: false, windows: [] })],
    ['a future reading', reading({ observedAt: '2026-11-02T13:00:00Z' })],
    ['a weekly window ending now', reading({ windows: [
      { id: 'seven_day', usedPct: 100, resetAt: '2026-11-02T12:00:00Z' },
    ] })],
    ['a weekly window that ended after observation', reading({ windows: [
      { id: 'seven_day', usedPct: 100, resetAt: '2026-11-02T11:59:00Z' },
    ] })],
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
