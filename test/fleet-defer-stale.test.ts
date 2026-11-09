import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDeferStale, explainDeferStale } from '../src/cli/fleet-defer-stale.js';

describe('fleet defer-stale', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('matches exact queued jobs and dependencies, prioritizes merges and retains claim times', () => {
    const rows = explainDeferStale([
      'old\tRQ-A\tdefer\tafter_open_RQ-MERGED',
      'new\tRQ-A\tdefer\tafter_open_RQ-MERGED',
      't2\tRQ-B\tdefer\tafter_open_RQ-OPEN',
      't3\tRQ-C\tdefer\tafter_open_RQ-READY',
      't4\tRQ-D\tdefer\tafter_open_RQ-MISSING',
      't5\tRQ-REMOVED\tdefer\tafter_open_RQ-OPEN',
      't6\tRQ-A\tdrop\tafter_open_RQ-OPEN',
      't7\tRQ-A\tdefer\tafter_open_',
    ].join('\n'), 'RQ-A\trepo\nRQ-B\trepo\nRQ-C\trepo\nRQ-D\trepo\nRQ-REMOVED-OTHER\trepo\n', [
      '- CLAIMED 12:30 dispatchd RQ-OPEN (pool=work): task',
      '- READY RQ-READY (pool=work): after RQ-MISSING',
      '- READY RQ-MERGED (pool=work): task',
      '- READY RQ-MISSING-OTHER (pool=work): task',
    ].join('\n'), [
      '{bad', JSON.stringify({ event: 'finish', state: 'MERGED', job: 'RQ-MISSING' }),
      JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-MERGED' }),
    ].join('\n'));
    expect(rows).toEqual([
      { id: 'RQ-A', dependency: 'RQ-MERGED', deferredAt: 'new', state: 'merged', claimTime: null },
      { id: 'RQ-B', dependency: 'RQ-OPEN', deferredAt: 't2', state: 'open', claimTime: '12:30' },
      { id: 'RQ-C', dependency: 'RQ-READY', deferredAt: 't3', state: 'open', claimTime: null },
      { id: 'RQ-D', dependency: 'RQ-MISSING', deferredAt: 't4', state: 'missing', claimTime: null },
    ]);
  });

  it('reads the overridden root, emits JSON and fails closed when evidence is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'defer-stale-'));
    try {
      await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
      await Promise.all([
        writeFile(join(root, 'queue/skipped-empty.tsv'), 't\tRQ-A\tdefer\tafter_open_RQ-B\n'),
        writeFile(join(root, 'queue/ready.tsv'), 'RQ-A\trepo\n'),
        writeFile(join(root, 'queue/router-queue.md'), '- CLAIMED 09:15 dispatchd RQ-B (task)\n'),
        writeFile(join(root, 'metrics/jobs.jsonl'), ''),
      ]);
      vi.stubEnv('ASHLR_RUNS_DIR', root);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetDeferStale(['--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ readOnly: true, rows: [{ id: 'RQ-A', state: 'open', claimTime: '09:15' }] });
      await rm(join(root, 'metrics/jobs.jsonl'));
      expect(await cmdFleetDeferStale(['--json'])).toBe(1);
      expect(error).toHaveBeenCalledWith('fleet defer-stale: queue or metrics evidence unavailable');
      expect(await cmdFleetDeferStale(['--bad'])).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
