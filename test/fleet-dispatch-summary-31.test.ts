import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cmdFleetDispatchSummary,
  dispatchSummaryReason,
  formatDispatchSummary,
  type DispatchSummaryReport,
} from '../src/cli/fleet-dispatch-summary.js';
import {
  dispatchManifestDir,
  type DispatchManifestEvent,
  type DispatchManifestEventsReadResult,
} from '../src/core/fleet/dispatch-manifest.js';
import type {
  DispatchIntentCounts,
  DispatchManifestEvidenceSummary,
} from '../src/core/fleet/dispatch-manifest-summary.js';

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-summary-cli-'));
  previousHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = path.join(tmp, 'store');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const repoPath = path.join(fs.realpathSync.native(os.tmpdir()), 'repo');
const log = () => vi.mocked(console.log).mock.calls.at(-1)![0] as string;
const lastReport = () => JSON.parse(log()) as DispatchSummaryReport;

function event(id: string, ts: string, overrides: Partial<DispatchManifestEvent> = {}): DispatchManifestEvent {
  return {
    schemaVersion: 1, manifestId: id, ts, mode: 'concurrent', dryRun: false,
    claimedItemIds: ['item-a', 'item-b'],
    assignments: [{ itemId: 'item-a', source: 'issue', repo: repoPath, title: 'title', backend: 'codex' }],
    unassigned: [{ itemId: 'item-b', reason: 'no-slots' }],
    slots: { codex: 1 }, backendCounts: { codex: 1 },
    counts: { claimed: 2, assigned: 1, unassigned: 1 },
    ...overrides,
  };
}

function manifestStore(): string {
  const dir = dispatchManifestDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writePartition(dir: string, date: string, text: string): void {
  fs.writeFileSync(path.join(dir, `${date}.jsonl`), text, { mode: 0o600 });
}

const row = (value: DispatchManifestEvent): string => `${JSON.stringify(value)}\n`;

const healthyRead = (events: DispatchManifestEvent[] = []): DispatchManifestEventsReadResult => ({
  events, sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
  filesRead: 1, bytesRead: 10, rowsScanned: events.length, invalidRows: 0, unreadableFiles: 0,
});

describe('ashlr fleet dispatch-summary', () => {
  it('prints a complete JSON summary for a populated store and writes nothing', async () => {
    const dir = manifestStore();
    writePartition(dir, '2026-10-30', row(event('dm-a', '2026-10-30T10:00:00.000Z')));
    writePartition(dir, '2026-10-31', row(event('dm-b', '2026-10-31T09:00:00.000Z')) +
      row(event('dm-c', '2026-10-31T11:00:00.000Z', { dryRun: true })));
    const entriesBefore = fs.readdirSync(dir).sort();

    expect(await cmdFleetDispatchSummary(['--json'])).toBe(0);
    expect(lastReport()).toMatchObject({
      schema: 'fleet.dispatch-summary.v1', coverage: 'complete', reason: null,
      earliestTimestamp: '2026-10-30T10:00:00.000Z', latestTimestamp: '2026-10-31T11:00:00.000Z',
      invalidTimestampCount: 0, duplicateRows: 0, conflictingManifests: 0,
      total: { manifests: 3, claimed: 6, assigned: 3, unassigned: 3, assignmentsByBackend: { codex: 3 } },
      live: { manifests: 2, claimed: 4, assigned: 2, unassigned: 2, assignmentsByBackend: { codex: 2 } },
      dryRun: { manifests: 1, claimed: 2, assigned: 1, unassigned: 1, assignmentsByBackend: { codex: 1 } },
      sourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, filesRead: 2 },
    });

    // Read-only: no lock file, no new directory entries, bytes unchanged.
    expect(fs.existsSync(path.join(dir, '.dispatch-manifests.lock'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(entriesBefore);

    expect(await cmdFleetDispatchSummary([])).toBe(0);
    expect(log()).toContain('coverage complete');
    expect(log()).toContain('3 manifest(s)');
  });

  it('reports unknown with a reason and exits nonzero when the store is missing', async () => {
    fs.mkdirSync(process.env['ASHLR_HOME']!, { recursive: true, mode: 0o700 });
    const dir = dispatchManifestDir();

    expect(await cmdFleetDispatchSummary(['--json'])).toBe(1);
    const report = lastReport();
    expect(report).toMatchObject({
      schema: 'fleet.dispatch-summary.v1', coverage: 'unknown',
      sourceQuality: { sourceState: 'missing', sourcePresent: false },
      total: { manifests: 0, claimed: 0, assigned: 0, unassigned: 0 },
    });
    expect(report.reason).toMatch(/missing/);

    expect(await cmdFleetDispatchSummary([])).toBe(1);
    expect(log()).toContain('coverage unknown');
    expect(log()).toContain('missing');
    // Inspection never creates the store it fails to find.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports partial coverage for a degraded read and exits nonzero', async () => {
    const dir = manifestStore();
    writePartition(dir, '2026-10-30', row(event('dm-a', '2026-10-30T10:00:00.000Z')) + '{"schemaVersion":1');

    expect(await cmdFleetDispatchSummary(['--json'])).toBe(1);
    const report = lastReport();
    expect(report.coverage).toBe('partial');
    expect(report.reason).toMatch(/invalid row/);
    expect(report).toMatchObject({
      total: { manifests: 1 }, sourceQuality: { sourceState: 'degraded', complete: false, invalidRows: 1 },
    });
  });

  it('validates arguments before reading and honors help', async () => {
    const reader = vi.fn(healthyRead);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdFleetDispatchSummary(['--bogus'], reader)).toBe(2);
    expect(await cmdFleetDispatchSummary(['extra'], reader)).toBe(2);
    expect(await cmdFleetDispatchSummary(['--json', 'tail'], reader)).toBe(2);
    expect(await cmdFleetDispatchSummary(['--help'], reader)).toBe(0);
    expect(await cmdFleetDispatchSummary(['--json', '-h'], reader)).toBe(0);
    expect(reader).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('--bogus'));
  });

  it('reports unknown instead of an empty healthy summary when the reader throws', async () => {
    const reader = () => { throw new Error('fixture-secret'); };
    expect(await cmdFleetDispatchSummary(['--json'], reader)).toBe(1);
    const report = lastReport();
    expect(report.coverage).toBe('unknown');
    expect(report.reason).toMatch(/could not be read/);
    expect(report.total.manifests).toBe(0);
  });
});

describe('dispatch summary report helpers', () => {
  const zero = (): DispatchIntentCounts => ({ manifests: 0, claimed: 0, assigned: 0, unassigned: 0, assignmentsByBackend: {} });
  const summary = (overrides: Partial<DispatchManifestEvidenceSummary> = {}): DispatchManifestEvidenceSummary => ({
    coverage: 'partial',
    sourceQuality: {
      sourceState: 'degraded', sourcePresent: true, complete: false, stopReasons: [],
      filesRead: 1, bytesRead: 10, rowsScanned: 0, invalidRows: 0, unreadableFiles: 0,
    },
    total: zero(), dryRun: zero(), live: zero(),
    earliestTimestamp: null, latestTimestamp: null,
    invalidTimestampCount: 0, duplicateRows: 0, conflictingManifests: 0,
    ...overrides,
  });

  it('explains missing, degraded and withheld evidence', () => {
    expect(dispatchSummaryReason(summary({ coverage: 'complete' }))).toBeNull();
    const missing = summary({
      coverage: 'unknown',
      sourceQuality: { ...summary().sourceQuality, sourceState: 'missing', sourcePresent: false },
    });
    expect(dispatchSummaryReason(missing)).toMatch(/missing/);
    const degraded = summary({
      sourceQuality: {
        ...summary().sourceQuality, stopReasons: ['file-limit'], unreadableFiles: 2, invalidRows: 3,
      },
      conflictingManifests: 1, invalidTimestampCount: 2,
    });
    const reason = dispatchSummaryReason(degraded)!;
    for (const part of ['2 unreadable file(s)', '3 invalid row(s)', 'file-limit', 'conflicting', 'invalid timestamp']) {
      expect(reason).toContain(part);
    }
  });

  it('formats unknown as a short block and partial with counts', () => {
    const unknown = formatDispatchSummary({
      schema: 'fleet.dispatch-summary.v1', ...summary({ coverage: 'unknown' }),
      reason: 'dispatch manifest store is missing',
    });
    expect(unknown).toContain('coverage unknown');
    expect(unknown).not.toContain('total:');
    const partial = formatDispatchSummary({
      schema: 'fleet.dispatch-summary.v1', ...summary(),
      reason: 'evidence is incomplete',
    });
    expect(partial).toContain('coverage partial');
    expect(partial).toContain('total:');
    expect(partial).toContain('dry-run:');
  });
});
