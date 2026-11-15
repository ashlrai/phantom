import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNED_FIELDS, type SanctionedReader } from '../src/core/fabric/lane-usage-self.js';
import { runSelfRefresh } from '../src/core/fabric/lane-usage-self-io.js';

// Regression: the refresh re-reads budget-overrides.json before writing, but it used to copy whole
// lane rows from its own snapshot, so a concurrent writer's target/policy/metadata inside a refreshed
// lane were rolled back. The readers here are the only injected seam; no HOME or provider is touched.

const T0 = Date.parse('2026-11-10T12:00:00Z');
const FUTURE = new Date(T0 + 2 * 86_400_000).toISOString();
const STALE = new Date(T0 - 2 * 3_600_000).toISOString();

function makeRuns(overrides?: unknown): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'usage-writer-147-'));
  mkdirSync(join(dir, 'queue'));
  mkdirSync(join(dir, 'metrics'));
  const file = join(dir, 'queue', 'budget-overrides.json');
  if (overrides !== undefined) writeFileSync(file, JSON.stringify(overrides));
  return { dir, file };
}

const readRoot = (file: string): Record<string, any> => JSON.parse(readFileSync(file, 'utf8'));

/** A reader that behaves like a concurrent writer: it edits the overrides file, then returns a reading. */
function concurrentWriter(file: string, mutate: (root: Record<string, any>) => void, reading: Awaited<ReturnType<SanctionedReader>>): SanctionedReader {
  return async () => {
    const root = readRoot(file);
    mutate(root);
    writeFileSync(file, JSON.stringify(root));
    return reading;
  };
}

const claudeReading = { pctUsed: 40, resetAt: FUTURE, source: 'claude-usage-reading' };

describe('runSelfRefresh applies only owned usage fields to the reread row', () => {
  it('keeps a concurrent writer\'s unowned lane fields and root keys while usage fields update', async () => {
    const { dir, file } = makeRuns({
      compact: { l1_free_gb: 9 },
      claude: {
        weekly_used_pct: 10, credits_remaining: null, reset_at: STALE, source: 'old', estimated: true,
        as_of: STALE, burn_pct_per_hour: null, unmeasured_jobs: 4, target: 'old-target', policy: { mode: 'manual' },
        metadata: { owner: 'a' },
      },
    });
    const result = await runSelfRefresh({
      runsDir: dir, nowMs: () => T0, lanes: ['claude'],
      readers: {
        claude: concurrentWriter(file, root => {
          root['claude'].target = 'new-target';
          root['claude'].policy = { mode: 'auto' };
          root['claude'].metadata = { owner: 'mason', note: 'kept' };
          root['compact'].l1_free_gb = 12;
          root['new_root'] = { flag: true };
        }, claudeReading),
      },
    });

    expect(result.outcomes).toEqual([expect.objectContaining({ lane: 'claude', action: 'read' })]);
    const out = readRoot(file);
    expect(out['claude']).toMatchObject({
      target: 'new-target', policy: { mode: 'auto' }, metadata: { owner: 'mason', note: 'kept' },
      weekly_used_pct: 40, source: 'claude-usage-reading', estimated: false, reset_at: FUTURE, as_of: new Date(T0).toISOString(),
    });
    expect(out['claude']).not.toHaveProperty('unmeasured_jobs');
    expect(out['compact']).toEqual({ l1_free_gb: 12 });
    expect(out['new_root']).toEqual({ flag: true });
  });

  it('leaves a kept lane exactly as the concurrent writer left it and initializes an absent lane', async () => {
    const { dir, file } = makeRuns({
      claude: { weekly_used_pct: 20, credits_remaining: null, reset_at: FUTURE, source: 'manual', estimated: false,
        as_of: new Date(T0 - 60_000).toISOString(), burn_pct_per_hour: null, target: 'a' },
    });
    await runSelfRefresh({
      runsDir: dir, nowMs: () => T0, lanes: ['claude', 'devin'],
      readers: {
        // devin's reader runs during the pass; it edits the claude row, which the pass keeps and must not write.
        devin: concurrentWriter(file, root => { root['claude'].target = 'b'; }, { pctUsed: 5, resetAt: FUTURE, source: 'devin-test' }),
      },
    });

    const out = readRoot(file);
    expect(out['claude']).toEqual({ weekly_used_pct: 20, credits_remaining: null, reset_at: FUTURE, source: 'manual',
      estimated: false, as_of: new Date(T0 - 60_000).toISOString(), burn_pct_per_hour: null, target: 'b' });
    expect(out['devin']).toMatchObject({ weekly_used_pct: 5, source: 'devin-test', estimated: false, reset_at: FUTURE });
  });

  it('replaces malformed lane rows with owned-field rows and never inherits from the prototype', async () => {
    const { dir, file } = makeRuns({ claude: 'oops' });
    await runSelfRefresh({
      runsDir: dir, nowMs: () => T0, lanes: ['claude', 'devin', 'zai'],
      readers: {
        claude: concurrentWriter(file, root => { root['claude'] = 'abc'; root['devin'] = [1, 2]; root['zai'] = null; }, claudeReading),
        devin: async () => ({ pctUsed: 7, resetAt: FUTURE, source: 'devin-test' }),
        zai: async () => ({ pctUsed: 9, resetAt: FUTURE, source: 'zai-test' }),
      },
    });

    const out = readRoot(file);
    for (const lane of ['claude', 'devin', 'zai']) {
      expect(Object.getPrototypeOf(out[lane])).toBe(Object.prototype);
      expect(Object.keys(out[lane]).every(k => (OWNED_FIELDS as readonly string[]).includes(k))).toBe(true);
    }
    expect(out['claude'].weekly_used_pct).toBe(40);
    expect(out['devin'].weekly_used_pct).toBe(7);
    expect(out['zai'].weekly_used_pct).toBe(9);
  });

  it('writes atomically with private permissions and leaves no temp file behind', async () => {
    const { dir, file } = makeRuns({});
    await runSelfRefresh({ runsDir: dir, nowMs: () => T0, lanes: ['claude'], readers: { claude: async () => claudeReading } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'queue'))).toEqual(['budget-overrides.json']);
  });
});
