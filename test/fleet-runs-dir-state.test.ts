import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaimedTsv, parseDispatchEvents, parseJobsMetrics, readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
const nowMs = Date.parse('2026-10-31T00:30:00Z');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-runs-')); dirs.push(dir);
  await cp(fileURLToPath(new URL('./fixtures/runs-dir/', import.meta.url)), dir, { recursive: true });
  await rename(join(dir, 'dispatch-events.txt'), join(dir, 'dispatch-events.log'));
  return dir;
}
const snapshot = (runsDir: string) => readFleetRunsDirState({ runsDir, now: () => nowMs });
describe('dispatchd runs directory', () => {
  it('projects all fixture sources independently', async () => {
    const s = await snapshot(await fixture());
    expect(s.sourceState).toBe('healthy');
    expect(s.lanes).toEqual([{ lane: 'codex-personal', running: 1, target: 2, floor: 1, ceiling: 3, queued: 4, held: false, heldReason: null, tokensLastHour: 12350, merged24h: 2, mergeRate24h: 0.5 }]);
    expect(s.publishesLastHour).toEqual([{ job: 'RQ-FAKE-1', lane: 'devin', url: 'https://github.com/example/fake/pull/1', at: '2026-10-31T00:03:21Z' }]);
    expect(s.events.map(e => e.kind)).toEqual(['PUBLISHED', 'LAUNCH']);
    expect(s.claimed[0]).toMatchObject({ job: 'RQ-FAKE-1', lane: 'codex-personal', tier: 'frontier' });
    expect(s.switches).toEqual(['HOLD']);
    expect(s.drop).toEqual({ pending: [{ lane: 'codex-personal', file: 'RQ-FAKE-1.md' }], done: 1 });
    expect(s.claudeLane).toBe('down fake maintenance');
    expect(s.diskFreeGb).toBe(123);
  });
  it('returns empty and unknown slices for a missing directory', async () => {
    const s = await snapshot(join(await fixture(), 'absent'));
    expect(s.sourceState).toBe('missing'); expect(s.runsDirPresent).toBe(false);
    for (const key of ['lanes', 'switches', 'publishesLastHour', 'events', 'claimed'] as const) expect(s[key]).toEqual([]);
    for (const key of ['lastTick', 'paused', 'memFreePct', 'diskFreeGb', 'claudeLane'] as const) expect(s[key]).toBeNull();
  });
  it('isolates corrupt status and oversized files', async () => {
    const dir = await fixture(); await writeFile(join(dir, 'queue/status.json'), '{');
    let s = await snapshot(dir);
    expect(s.sourceState).toBe('degraded'); expect(s.sources.status).toBe('degraded');
    expect(s.lanes).toEqual([]); expect(s.publishesLastHour).toHaveLength(1);
    await writeFile(join(dir, 'metrics/jobs.jsonl'), ' '.repeat(8 * 1024 * 1024 + 1));
    s = await snapshot(dir); expect(s.sources.metrics).toBe('degraded'); expect(s.events).toHaveLength(2);
  });
  it('keeps unknown metrics null and marks malformed events degraded', async () => {
    const dir = await fixture();
    await rm(join(dir, 'metrics/jobs.jsonl'));
    await writeFile(join(dir, 'dispatch-events.log'), 'corrupt log row');
    const s = await snapshot(dir);
    expect(s.sources.metrics).toBe('missing'); expect(s.lanes[0].tokensLastHour).toBeNull();
    expect(s.sources.events).toBe('degraded');
    expect(parseDispatchEvents('2026-02-30 00:00:00 LAUNCH invalid')).toEqual([]);
  });
  it('scrubs secrets, paths and prompt suffixes before truncating', () => {
    const text = parseDispatchEvents('2026-10-31 00:00:00 INCIDENT token=fake-secret-value /tmp/private prompt=private words')[0].text;
    expect(text).not.toContain('fake-secret-value'); expect(text).not.toContain('/tmp/private'); expect(text).not.toContain('private words');
  });
  it('validates parser rows, bounds events and orders publishes', () => {
    expect(parseClaimedTsv('bad/job\tcodex-personal\tx\t00:00\t1')).toEqual([]);
    expect(parseDispatchEvents(Array.from({ length: 500 }, (_, i) => `2026-10-31 00:00:00 LAUNCH ${i}`).join('\n'))).toHaveLength(40);
    const row = { event: 'publish', job: 'RQ-FAKE-1', class: 'pr', ts: '2026-10-31T00:20:00Z', url: 'https://evil.example/fake' };
    const result = parseJobsMetrics([JSON.stringify(row), '{', JSON.stringify({ ...row, job: '../bad' })].join('\n'), nowMs);
    const many = Array.from({ length: 60 }, (_, i) => JSON.stringify({ ...row, ts: new Date(nowMs - i * 1000).toISOString() })).reverse().join('\n');
    const ordered = parseJobsMetrics(many, nowMs).publishes;
    expect(ordered).toHaveLength(50); expect(ordered[0].at).toBe(new Date(nowMs).toISOString());
    expect(result.publishes).toEqual([{ job: 'RQ-FAKE-1', lane: null, url: null, at: row.ts }]);
  });
  it('reads only complete metrics lines from the last MiB', async () => {
    const dir = await fixture();
    const row = JSON.stringify({ event: 'finish', job: 'RQ-FAKE-1', lane: 'codex-personal', tokens_total: 7, ts: '2026-10-31T00:20:00Z' });
    await writeFile(join(dir, 'metrics/jobs.jsonl'), `${'x'.repeat(1024 * 1024)}\n${row}\n`);
    const s = await snapshot(dir); expect(s.sources.metrics).toBe('healthy'); expect(s.lanes[0].tokensLastHour).toBe(7);
  });
});
