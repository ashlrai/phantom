import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { main } from '../examples/dispatch-manifest-evidence.js';
import { dispatchManifestDir, recordDispatchManifest, type DispatchManifestEvent } from '../src/core/fleet/dispatch-manifest.js';

let tmp: string;
let previousHome: string | undefined;
let directory: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-recipe-'));
  previousHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = path.join(tmp, 'store');
  directory = dispatchManifestDir();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function event(id: string, dryRun = false): DispatchManifestEvent {
  return {
    schemaVersion: 1, manifestId: id, ts: '2026-10-30T10:00:00.000Z', mode: 'concurrent', dryRun,
    claimedItemIds: ['assigned-item', 'waiting-item'],
    assignments: [{ itemId: 'assigned-item', source: 'todo', repo: path.join(fs.realpathSync(os.tmpdir()), 'fake-repo'), title: 'Fake task', backend: 'codex' }],
    unassigned: [{ itemId: 'waiting-item', reason: 'no-slots' }],
    slots: { codex: 1 }, backendCounts: { codex: 1 }, counts: { claimed: 2, assigned: 1, unassigned: 1 },
  };
}

function write(...events: DispatchManifestEvent[]) {
  for (const value of events) expect(recordDispatchManifest(value)).toMatchObject({ recorded: true });
}

function run(...args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const result = main(args);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual(result);
  log.mockRestore();
  return result;
}

describe('dispatch manifest evidence example', () => {
  it('uses real event records, deduplicates equal IDs and excludes conflicting IDs', () => {
    const duplicate = event('duplicate');
    write(duplicate, duplicate, event('conflict'), event('conflict', true), event('dry', true));
    const file = path.join(directory, '2026-10-30.jsonl');
    const before = fs.readFileSync(file);
    const previousSelection = process.env.ASHLR_HOME;
    process.env.ASHLR_HOME = path.join(tmp, 'different-store');
    const result = run('--manifest-events-dir', directory);
    expect(process.env.ASHLR_HOME).toBe(path.join(tmp, 'different-store'));
    process.env.ASHLR_HOME = previousSelection;
    expect(fs.readFileSync(file)).toEqual(before);
    expect(result).toMatchObject({
      intentOnly: true,
      guidance: expect.stringMatching(/fleet workers and job evidence.*actual launches/i),
      summary: {
        coverage: 'partial', duplicateRows: 2, conflictingManifests: 1,
        sourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], filesRead: 1, bytesRead: before.length, rowsScanned: 5, invalidRows: 0, unreadableFiles: 0 },
        total: { manifests: 2, claimed: 4, assigned: 2, unassigned: 2, assignmentsByBackend: { codex: 2 } },
        dryRun: { manifests: 1, claimed: 2, assigned: 1, unassigned: 1, assignmentsByBackend: { codex: 1 } },
        live: { manifests: 1, claimed: 2, assigned: 1, unassigned: 1, assignmentsByBackend: { codex: 1 } },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/assigned-item|waiting-item|fake-repo|Fake task/);
  });

  it('preserves corrupt and torn row quality while counting committed records', () => {
    write(event('first'), event('second', true));
    const file = path.join(directory, '2026-10-30.jsonl');
    fs.appendFileSync(file, '{bad json}\n{"schemaVersion":1');
    const size = fs.statSync(file).size;
    const result = run('--manifest-events-dir', directory);
    expect(result.summary).toMatchObject({
      coverage: 'partial', duplicateRows: 0, conflictingManifests: 0,
      total: { manifests: 2, claimed: 4, assigned: 2, unassigned: 2 },
      sourceQuality: { sourceState: 'degraded', sourcePresent: true, complete: false, stopReasons: [], filesRead: 1, bytesRead: size, rowsScanned: 4, invalidRows: 2, unreadableFiles: 0 },
    });
  });

  it('reports bounded reads and absent stores without silently using another location', () => {
    write(event('first'), event('second', true));
    const limited = run('--manifest-events-dir', directory, '--max-rows', '1');
    expect(limited.summary).toMatchObject({ coverage: 'partial', total: { manifests: 1 }, sourceQuality: { complete: false, sourceState: 'degraded', rowsScanned: 1, stopReasons: ['row-limit'] } });
    const missing = run('--manifest-events-dir', path.join(tmp, 'missing', 'dispatch-manifests'));
    expect(missing.summary).toMatchObject({ coverage: 'unknown', total: { manifests: 0 }, sourceQuality: { sourcePresent: false, sourceState: 'missing' } });
  });

  it('requires an explicit absolute manifest directory and rejects malformed arguments', () => {
    for (const args of [[], ['--manifest-events-dir', 'relative/dispatch-manifests'], ['--manifest-events-dir', tmp], ['--max-rows', '0'], ['--manifest-events-dir', directory, '--max-rows', '1.5'], ['--manifest-events-dir', directory, '--unknown', 'x']]) {
      expect(() => main(args)).toThrow(/Usage:/);
    }
  });

  it('runs as a CLI and emits JSON or a nonzero usage error', () => {
    write(event('cli'));
    const tsx = path.resolve('node_modules/.bin/tsx');
    const example = path.resolve('examples/dispatch-manifest-evidence.ts');
    const output = execFileSync(tsx, [example, '--manifest-events-dir', directory], { encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ intentOnly: true, summary: { coverage: 'complete', total: { manifests: 1, assigned: 1 } } });
    const invalid = spawnSync(tsx, [example], { encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Usage:');
  }, 30_000);
});
