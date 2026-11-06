import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { cmdFleetStagingInventoryBatch } from '../src/cli/fleet-staging-inventory-batch.js';
import { ELIGIBILITY, inventoryStaging } from '../src/core/fleet/staging-inventory.js';

type Report = Awaited<ReturnType<typeof inventoryStaging>>;
const report = (root: string, complete = true): Report => ({
  schema: 'fleet.staging-inventory.v1', generatedAt: '2026-01-01T00:00:00.000Z', root,
  source: complete ? 'ok' : 'degraded', complete, truncated: false, skippedSymlinks: 0,
  entries: [{ name: 'unknown', modifiedAt: '2026-01-01', bytes: null }], totalMeasuredBytes: 0,
  cleanupEligibility: ELIGIBILITY,
});
const input = (chunks: (string | Uint8Array)[]) => (async function* () { yield* chunks; })();

function harness(chunks: (string | Uint8Array)[], scanner: (root: string) => Promise<Report>) {
  const lines: string[] = [], errors: string[] = [];
  return { lines, errors, deps: { input: input(chunks), scanner, output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) } } };
}

describe('staging inventory batch', () => {
  it('reads split UTF-8 chunks, scans serially, continues failures and sanitizes the aggregate', async () => {
    const roots = ['/fake/a', '/fake/b', '/fake/c'];
    const bytes = Buffer.from(JSON.stringify({ version: 1, roots }));
    let active = 0, max = 0;
    const calls: string[] = [];
    const h = harness([bytes.subarray(0, 7), bytes.subarray(7)], async (root) => {
      calls.push(root); active++; max = Math.max(max, active);
      await Promise.resolve(); active--;
      if (root === roots[1]) throw new Error('private error');
      return { ...report(root, root !== roots[0]), entries: [{ name: `${homedir()}/private`, modifiedAt: 'x', bytes: null }] };
    });
    expect(await cmdFleetStagingInventoryBatch(['--stdin', '--json'], h.deps)).toBe  (1);
    expect(calls).toEqual(roots); expect(max).toBe(1);
    const result = JSON.parse(h.lines[0]!);
    expect(result.requested).toBe(3); expect(result.completed).toBe(1);
    expect(result.reports[0].entries[0].bytes).toBeNull();
    expect(result.reports[1]).toEqual({ root: roots[1], complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY });
    expect(h.lines[0]).not.toContain(homedir()); expect(h.lines[0]).not.toContain('private error');
    expect(result.reports[0].entries[0].name).toBe('~/private');
  });

  it('rejects all invalid input before scanning', async () => {
    const invalid: (string | Uint8Array)[][] = [
      ['{}'], ['{"version":1,"roots":["relative"]}'], ['{"version":1,"roots":["/a","/a/."]}'],
      [JSON.stringify({ version: 1, roots: ['/a'], extra: true })],
      [JSON.stringify({ version: 1, roots: Array.from({ length: 9 }, (_, i) => `/a${i}`) })],
      [Buffer.from([0xff])], [' '.repeat(16385)], ['{"version":1,"roots":["/a"]} {}'],
      ['{"version":1,"roots":["/a\\u0000b"]}'],
    ];
    for (const chunks of invalid) {
      let calls = 0; const h = harness(chunks, async (root) => { calls++; return report(root); });
      expect(await cmdFleetStagingInventoryBatch(['--stdin'], h.deps)).toBe(2);
      expect(calls).toBe(0);
    }
    for (const args of [[], ['--stdin', '--stdin'], ['--stdin', '--json', '--json'], ['--stdin', '--apply']]) {
      const h = harness(['{}'], async (root) => report(root));
      expect(await cmdFleetStagingInventoryBatch(args, h.deps)).toBe(2);
    }
    const h = harness(['{}'], async (root) => report(root));
    expect(await cmdFleetStagingInventoryBatch(['--stdin'], { ...h.deps, input: Object.assign(input([]), { isTTY: true }) })).toBe(2);
  });

  it('returns success for complete reports and emits human lines with the warning', async () => {
    const h = harness([JSON.stringify({ version: 1, roots: ['/a/../b'] })], async (root) => report(root));
    expect(await cmdFleetStagingInventoryBatch(['--stdin'], h.deps)).toBe(0);
    expect(h.lines.join('\n')).toContain('/b'); expect(h.lines.join('\n')).toContain(ELIGIBILITY);
  });
});
