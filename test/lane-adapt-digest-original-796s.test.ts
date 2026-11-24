import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';

const now = new Date('2026-11-10T20:00:00Z');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const base: Partial<StatusDigestSources> = {
  installedVersion: () => '1.0.0', publishedVersion: async () => '1.0.0',
  mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
  runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [] }),
  needs: () => ({ status: 'missing', items: [] }), inbox: async () => ({ sourceState: 'healthy', entries: [] }),
  mergeLatency: undefined, workClaims: undefined, peers: undefined, nodeRuns: undefined,
  gapLine: undefined, diskLine: undefined, supplyLine: undefined, yieldLine: undefined,
  wasteLine: undefined, authLine: undefined, notLiveLine: undefined, blocker: undefined,
};
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adapt-digest-')); dirs.push(dir);
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
  return dir;
}
async function evidence(dir: string): Promise<void> {
  await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({
    schema: 'dispatchd.status.v1', last_tick: now.toISOString(), paused: null, mem_free_pct: 50,
    lanes: { fake: { running: 1, target: 2, queued: 0, held: false } },
  }));
  await writeFile(join(dir, 'queue', 'dispatch-events.log'), '2026-11-10T19:30:00Z ADAPT fake 8->2 reason=backoff:memguard\n');
  await writeFile(join(dir, 'metrics', 'jobs.jsonl'), JSON.stringify({ ts: '2026-11-10T19:40:00Z', event: 'launch', mem_free_pct: 50 }) + '\n');
}
describe('lane adaptation in the leader digest', () => {
  it('reads the supplied runs directory and clock through the default source', async () => {
    const dir = await temp(); await evidence(dir);
    const lines = buildStatusDigest(await gatherStatusDigestInput(dir, now, base));
    expect(lines).toContain('adapt: fake is at 2 of 8 slots but the cause (memory) cleared over 10 min ago');
    const earlier = buildStatusDigest(await gatherStatusDigestInput(dir, new Date('2026-11-10T19:45:00Z'), base));
    expect(earlier.some(line => line.startsWith('adapt:'))).toBe(false);
    const missing = buildStatusDigest(await gatherStatusDigestInput(await temp(), now, base));
    expect(missing.some(line => line.startsWith('adapt:'))).toBe(false);
  });
  it('isolates a failed reader and preserves unrelated facts', async () => {
    const dir = await temp();
    const ordinary = buildStatusDigest(await gatherStatusDigestInput(dir, now, { ...base, adaptLine: async () => null }));
    const failed = buildStatusDigest(await gatherStatusDigestInput(dir, now, { ...base, adaptLine: async () => { throw new Error('failure'); } }));
    expect(failed).toEqual(ordinary);
    expect(failed).toContain('Merges: 0 in the last hour · 0 in the last 24h');
  });
  it('sanitizes and bounds an injected line', async () => {
    const dir = await temp();
    const lines = buildStatusDigest(await gatherStatusDigestInput(dir, now, { ...base, adaptLine: async () => `adapt: ${'x'.repeat(200)}\nnext` }));
    const line = lines.find(value => value.startsWith('adapt:'))!;
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).not.toContain('\n');
  });
});
