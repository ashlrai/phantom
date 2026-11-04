import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergedJobsFromJsonl,
  parseDependencyGateIds,
  readFleetQueue,
} from '../src/core/fleet/runs-parked-queue.js';

const now = new Date(2026, 10, 3, 12).getTime();

describe('fleet parked unmet deps (RQ-QUEUE-AUTOUNPARK-1)', () => {
  it('parses DEPENDENCY GATE ids and MERGED outcomes', () => {
    expect(parseDependencyGateIds('DEPENDENCY GATE: RQ-A, RQ-B\nbody')).toEqual(['RQ-A', 'RQ-B']);
    expect(parseDependencyGateIds('no gate here')).toEqual([]);
    expect(mergedJobsFromJsonl(
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-A' })}\n`
      + `${JSON.stringify({ event: 'finish', state: 'MERGED', job: 'RQ-B' })}\n`,
    )).toEqual(new Set(['RQ-A']));
  });

  it('lists PARKED-DEP rows whose gate ids are not all MERGED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-unmet-deps-'));
    try {
      await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
      await mkdir(join(dir, 'metrics'), { recursive: true });
      const prompt = join(dir, 'queue', 'prompts', 'RQ-WAIT.md');
      await writeFile(prompt, 'DEPENDENCY GATE: RQ-UP-A, RQ-UP-B\n\nno merge without Security pin\n');
      await writeFile(join(dir, 'queue', 'ready.tsv'), [
        `PARKED-DEP.devin\tRQ-WAIT\tdevin\twork\tphantom\t${prompt}`,
        'PARKED-BYHAND.devin\tRQ-HAND\tdevin\twork\tphantom\tprompts/x.md',
        'READY\tRQ-READY\tdevin\twork\tphantom\tprompts/y.md',
      ].join('\n'));
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
        `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-UP-A' })}\n`);
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result.parked).toBe(2);
      expect(result.groups.some((g) => g.reason === 'DEP' && g.jobs.includes('RQ-WAIT'))).toBe(true);
      expect(result.unmetDeps).toEqual([
        { job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-UP-B'] },
      ]);
      expect(JSON.stringify(result)).not.toContain(prompt);
      expect(JSON.stringify(result)).not.toContain('no merge without Security pin');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits PARKED-DEP rows once every gate id is MERGED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-unmet-deps-met-'));
    try {
      await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
      await mkdir(join(dir, 'metrics'), { recursive: true });
      const prompt = join(dir, 'queue', 'prompts', 'RQ-WAIT.md');
      await writeFile(prompt, 'DEPENDENCY GATE: RQ-UP-A\n');
      await writeFile(join(dir, 'queue', 'ready.tsv'),
        `PARKED-DEP.codex-local\tRQ-WAIT\tcodex-local\twork\tphantom\t${prompt}\n`);
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
        `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-UP-A' })}\n`);
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result.unmetDeps).toEqual([]);
      expect(result.groups[0]).toMatchObject({ reason: 'DEP', jobs: ['RQ-WAIT'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
