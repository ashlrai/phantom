import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach } from 'vitest';
import { cmdFleetStagingInventoryBatch } from '../src/cli/fleet-staging-inventory-batch.js';
import { inventoryStaging, ELIGIBILITY } from '../src/core/fleet/staging-inventory.js';
import { StagingScanner, readStagingBatch } from '../src/mcp/fleet-staging-inventory-batch.js';

type Report = Awaited<ReturnType<typeof inventoryStaging>>;
const makeReport = (root: string): Report => ({
  schema: 'fleet.staging-inventory.v1', generatedAt: '2026-01-01T00:00:00.000Z', root,
  source: 'ok', complete: true, truncated: false, skippedSymlinks: 0,
  entries: [], totalMeasuredBytes: 0, cleanupEligibility: ELIGIBILITY,
});
const envelope = (roots: string[]) => JSON.stringify({ version: 1, roots });
const threeRoots = ['/tmp/fake-stop-r1', '/tmp/fake-stop-r2', '/tmp/fake-stop-r3'];

describe('staging batch interrupted scan retains all requested roots', () => {
  it('keeps truthful counts and no scanner calls when cancelled before scanning', async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    // Signal emitted DURING generator iteration – readRoots completes,
    // then scanning loop sees stopped and breaks with zero scanner calls.
    const input = (async function* () { signals.emit('SIGINT'); yield envelope(threeRoots); })();
    const status = await cmdFleetStagingInventoryBatch(['--stdin', '--json'], {
      signals, input,
      scanner: async root => makeReport(root),
      output: { log: line => lines.push(line), error: () => {} },
    });
    expect(status).toBe(130);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.requested).toBe(3);
    expect(parsed.completed).toBe(0);
    expect(parsed.attempted).toBe(0);
    expect(parsed.remaining).toBe(3);
    expect(parsed.reports).toHaveLength(3);
    expect(parsed.reports.map((r: { root: string }) => r.root)).toEqual(threeRoots);
    expect(parsed.reports.map((r: { source: string }) => r.source)).toEqual(['unattempted', 'unattempted', 'unattempted']);
    expect(signals.eventNames()).toEqual([]);
  });

  it('retains all three root identities in JSON when interrupted during first scan', async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    // Scanner emits signal from within, resolves normally. The next
    // iteration checks stopped and breaks, leaving r2/r3 as sentinels.
    const scannerCalls: string[] = [];
    const input = (async function* () { yield envelope(threeRoots); })();
    const status = await cmdFleetStagingInventoryBatch(['--stdin', '--json'], {
      signals, input,
      scanner: async root => {
        scannerCalls.push(root);
        signals.emit('SIGINT');
        return makeReport(root);
      },
      output: { log: line => lines.push(line), error: () => {} },
    });
    expect(status).toBe(130);
    expect(scannerCalls).toEqual([threeRoots[0]]);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema).toBe('fleet.staging-inventory-batch.v1');
    expect(parsed.requested).toBe(3);
    expect(parsed.completed).toBe(1);
    expect(parsed.interrupted).toBe(true);
    expect(parsed.signal).toBe('SIGINT');
    expect(parsed.attempted).toBe(1);
    expect(parsed.remaining).toBe(2);
    expect(parsed.reports).toHaveLength(3);
    expect(parsed.reports[0]).toMatchObject({ root: threeRoots[0], complete: true });
    expect(parsed.reports[1]).toMatchObject({
      root: threeRoots[1], complete: false, source: 'unattempted',
      cleanupEligibility: ELIGIBILITY,
    });
    expect(parsed.reports[2]).toMatchObject({
      root: threeRoots[2], complete: false, source: 'unattempted',
      cleanupEligibility: ELIGIBILITY,
    });
    expect(signals.eventNames()).toEqual([]);
  });

  it('returns exit 143 for SIGTERM and keeps all roots in JSON order', async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    const scannerCalls: string[] = [];
    const input = (async function* () { yield envelope(threeRoots); })();
    const status = await cmdFleetStagingInventoryBatch(['--stdin', '--json'], {
      signals, input,
      scanner: async root => {
        scannerCalls.push(root);
        signals.emit('SIGTERM');
        return makeReport(root);
      },
      output: { log: line => lines.push(line), error: () => {} },
    });
    expect(status).toBe(143);
    expect(scannerCalls).toEqual([threeRoots[0]]);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.signal).toBe('SIGTERM');
    expect(parsed.reports).toHaveLength(3);
    expect(parsed.reports.map((r: { root: string }) => r.root)).toEqual(threeRoots);
  });

  it('retains all roots in NDJSON when interrupted during first scan', async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    const scannerCalls: string[] = [];
    const input = (async function* () { yield envelope(threeRoots); })();
    await cmdFleetStagingInventoryBatch(['--stdin', '--ndjson'], {
      signals, input,
      scanner: async root => {
        scannerCalls.push(root);
        signals.emit('SIGINT');
        return makeReport(root);
      },
      output: { log: line => lines.push(line), error: () => {} },
    });
    expect(scannerCalls).toEqual([threeRoots[0]]);
    // Progress event for the attempted scan
    expect(lines).toHaveLength(2);
    const progress = JSON.parse(lines[0]!);
    expect(progress.schema).toBe('fleet.staging-inventory-batch-progress.v1');
    expect(progress.index).toBe(0);
    expect(progress.report.root).toBe(threeRoots[0]);
    // Summary with interrupt metadata
    const summary = JSON.parse(lines[1]!);
    expect(summary.schema).toBe('fleet.staging-inventory-batch-summary.v1');
    expect(summary.interrupted).toBe(true);
    expect(summary.signal).toBe('SIGINT');
    expect(summary.attempted).toBe(1);
    expect(summary.remaining).toBe(2);
  });

  it('skipped roots show as "skipped (unattempted)" in text mode', async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    const scannerCalls: string[] = [];
    const input = (async function* () { yield envelope(threeRoots); })();
    await cmdFleetStagingInventoryBatch(['--stdin'], {
      signals, input,
      scanner: async root => {
        scannerCalls.push(root);
        signals.emit('SIGINT');
        return makeReport(root);
      },
      output: { log: line => lines.push(line), error: () => {} },
    });
    expect(scannerCalls).toEqual([threeRoots[0]]);
    const text = lines.join('\n');
    expect(text).toContain('skipped (unattempted)');
    for (const root of threeRoots.slice(1)) {
      expect(text).toContain(root);
    }
  });

  it('preserves unattempted sentinels matching the MCP data contract', async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    const mcpResult = await readStagingBatch(threeRoots, async root => {
      seen.push(root);
      return makeReport(root);
    }, controller.signal);
    // MCP produces sentinel entries when pre-aborted
    expect(seen).toEqual([]);
    expect(mcpResult).toMatchObject({
      requested: 3, completed: 0, cancelled: true, complete: false,
      reports: threeRoots.map(root => ({ root, source: 'unattempted', complete: false })),
    });
    // CLI path: emit a signal during scanning to trigger sentinels
    const cliSignals = new EventEmitter();
    const cliLines: string[] = [];
    const input = (async function* () { yield envelope(threeRoots); })();
    await cmdFleetStagingInventoryBatch(['--stdin', '--json'], {
      signals: cliSignals, input,
      scanner: async (root: string) => {
        cliSignals.emit('SIGINT');
        return makeReport(root);
      },
      output: { log: line => cliLines.push(line), error: () => {} },
    });
    const cliParsed = JSON.parse(cliLines[0]!);
    // Both paths produce sentinel entries for unattempted roots
    expect(cliParsed.reports).toHaveLength(3);
    for (const r of cliParsed.reports.slice(1)) {
      expect(r).toHaveProperty('root');
      expect(r).toHaveProperty('complete', false);
      expect(r).toHaveProperty('source', 'unattempted');
      expect(r).toHaveProperty('cleanupEligibility', ELIGIBILITY);
    }
  });

  it('emits no extra scanner calls when cancelled before scanning', async () => {
    const signals = new EventEmitter();
    const input = (async function* () { signals.emit('SIGINT'); yield envelope(threeRoots); })();
    let counter = 0;
    await cmdFleetStagingInventoryBatch(['--stdin', '--json'], {
      signals, input,
      scanner: async () => { counter++; return makeReport('x'); },
      output: { log: () => {}, error: () => {} },
    });
    expect(counter).toBe(0);
  });

  it('removes signal listeners after both successful and interrupted completion', async () => {
    const signals = new EventEmitter();
    const input = (async function* () { yield envelope(threeRoots); })();
    await cmdFleetStagingInventoryBatch(['--stdin', '--json'], {
      signals, input, scanner: async root => makeReport(root),
      output: { log: () => {}, error: () => {} },
    });
    expect(signals.eventNames()).toEqual([]);
  });
});
