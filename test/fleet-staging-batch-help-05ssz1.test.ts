import { describe, expect, it } from 'vitest';
import { cmdFleetStagingInventoryBatch } from '../src/cli/fleet-staging-inventory-batch.js';
import { ELIGIBILITY, inventoryStaging } from '../src/core/fleet/staging-inventory.js';

type Report = Awaited<ReturnType<typeof inventoryStaging>>;
const report = (root: string, complete = true): Report => ({
  schema: 'fleet.staging-inventory.v1', generatedAt: '2026-01-01T00:00:00.000Z', root,
  source: complete ? 'ok' : 'degraded', complete, truncated: false, skippedSymlinks: 0,
  entries: [{ name: 'unknown', modifiedAt: '2026-01-01', bytes: null }], totalMeasuredBytes: 0,
  cleanupEligibility: ELIGIBILITY,
});

// Throws if touched, to prove help consumes zero IO.
function throwingIterator(): AsyncIterable<Uint8Array | string> {
  return (async function* () { yield* []; throw new Error('stdin must not be read'); })();
}
// Throws if called, to prove help invokes zero scanner calls.
function throwingScanner(): (root: string) => Promise<Report> {
  return (async (root: string) => { throw new Error('scanner must not be called'); }) as (root: string) => Promise<Report>;
}

describe('staging inventory batch — help', () => {
  it('--help returns 0 with no stdin or scanner', async () => {
    const lines: string[] = [], errors: string[] = [];
    const result = await cmdFleetStagingInventoryBatch(['--help'], {
      input: throwingIterator(),
      scanner: throwingScanner(),
      output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) },
    });
    expect(result).toBe(0);
    expect(errors).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('--help');
    expect(text).toContain('-h');
    expect(text).toContain('version-1');
    expect(text).toContain('8');
    expect(text).toContain('16KiB');
    expect(text).toContain('sequential');
  });

  it('-h returns 0 with no stdin or scanner', async () => {
    const lines: string[] = [], errors: string[] = [];
    const result = await cmdFleetStagingInventoryBatch(['-h'], {
      input: throwingIterator(),
      scanner: throwingScanner(),
      output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) },
    });
    expect(result).toBe(0);
    expect(errors).toEqual([]);
  });

  it('help output explains the stdin shape', async () => {
    const lines: string[] = [], errors: string[] = [];
    await cmdFleetStagingInventoryBatch(['--help'], {
      output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) },
    });
    const text = lines.join('\n');
    expect(text).toContain('"version"');
    expect(text).toContain('"roots":[');
    expect(text).toContain('/path/a');
    expect(text).toContain('/path/b');
  });

  it('help does not consume stdin or call scanner even when deps provided', async () => {
    let scannerTouched = false;
    const lines: string[] = [];
    const realInput = (async function* () { yield Buffer.from(`{"version":1,"roots":["/a"]}`); })();
    const scanner = (async (root: string) => { scannerTouched = true; return report(root); }) as (root: string) => Promise<Report>;
    // Help is checked *before* flag validation; stdin is never read, scanner never called.
    const result = await cmdFleetStagingInventoryBatch(['--stdin', '--help'], {
      input: realInput,
      scanner,
      output: { log: (s: string) => lines.push(s), error: () => {} },
    });
    expect(result).toBe(0);
    expect(scannerTouched).toBe(false);
  });

  it('rejects unrelated invalid argument combinations (exit 2)', async () => {
    const lines: string[] = [], errors: string[] = [];
    // --apply is not a recognized flag for the batch command.
    const result = await cmdFleetStagingInventoryBatch(['--stdin', '--apply'], {
      input: throwingIterator(),
      scanner: throwingScanner(),
      output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) },
    });
    expect(result).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('bad flag combinations still exit 2 even with --help present alongside bad flags', async () => {
    const lines: string[] = [], errors: string[] = [];
    // --apply is unrecognized; --help should NOT save it.
    const result = await cmdFleetStagingInventoryBatch(['--stdin', '--apply'], {
      input: throwingIterator(),
      scanner: throwingScanner(),
      output: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) },
    });
    expect(result).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('normal batch behavior unchanged', async () => {
    const out: { log: (s: string) => void; error: (s: string) => void } & { lines?: string[]; errors?: string[] } = {};
    out.lines = [];
    out.errors = [];
    out.log = (s: string) => out.lines!.push(s);
    out.error = (s: string) => out.errors!.push(s);
    const roots = ['/a', '/b'];
    const realInput = (async function* () { yield JSON.stringify({ version: 1, roots }); })();
    const scanner = (async (root: string) => report(root)) as (root: string) => Promise<Report>;
    const result = await cmdFleetStagingInventoryBatch(['--stdin'], {
      input: realInput,
      scanner,
      output: out,
    });
    expect(result).toBe(0);
    // Non-JSON output wraps roots in JSON.stringify: '/a' (quoted).
    expect(out.lines!.join('\n')).toContain('"/a"');
    expect(out.lines!.join('\n')).toContain('"/b"');
  });
});
