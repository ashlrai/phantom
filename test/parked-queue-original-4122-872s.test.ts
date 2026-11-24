import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergedJobsFromJsonl, parseDependencyGateIds, readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const now = Date.parse('2026-11-24T12:00:00Z');

async function withRuns(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'parked-original-872s-'));
  try {
    await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'queue', 'precheck-skips.tsv'), '');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const parked = (state: string, job: string, prompt: string) =>
  `${state}\t${job}\tdevin\twork\tphantom\tprompts/${prompt}.md`;
const ready = (job: string, lane = 'devin') => `READY\t${job}\t${lane}\twork\tphantom\tprompts/ready.md`;

describe('original 4122 parked queue preservation', () => {
  it('parses gate IDs and original and newer MERGED ledger dialects', () => {
    expect(parseDependencyGateIds('DEPENDENCY GATE: RQ-A, RQ-B and RQ-A\nignore RQ-C')).toEqual(['RQ-A', 'RQ-B']);
    expect(parseDependencyGateIds('no gate')).toEqual([]);
    expect(mergedJobsFromJsonl([
      JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-A' }),
      JSON.stringify({ type: 'outcome', status: 'merged', job_id: 'RQ-B' }),
      JSON.stringify({ event: 'finish', state: 'MERGED', job: 'RQ-C' }),
      '{malformed',
    ].join('\n'))).toEqual(new Set(['RQ-A', 'RQ-B']));
  });

  it('separates unmet gates from opt-in stale parks across queue dialects', async () => {
    await withRuns(async (root) => {
      await writeFile(join(root, 'queue/prompts/wait.md'), 'DEPENDENCY GATE: RQ-A, RQ-B\n');
      await writeFile(join(root, 'queue/prompts/met.md'), 'DEPENDENCY GATE: RQ-A\n');
      await writeFile(join(root, 'queue/ready.tsv'), [
        parked('PARKED-DEP.devin', 'RQ-WAIT', 'wait'),
        'RQ-STALE\tphantom\tPARKED-DEPENDENCY.devin\twork\tprompts/met.md',
      ].join('\n'));
      await writeFile(join(root, 'metrics/jobs.jsonl'), JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-A' }));
      const ordinary = await readFleetQueue({ runsDir: root, now: () => now });
      expect(ordinary.unmetDeps).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-B'] }]);
      expect(ordinary).not.toHaveProperty('metDeps');
      const detail = await readFleetQueue({ runsDir: root, now: () => now, depDetail: true });
      expect(detail.metDeps).toEqual([{ job: 'RQ-STALE', lane: 'devin', gates: ['RQ-A'] }]);
      expect(detail.generatedAt).toBe('2026-11-24T12:00:00.000Z');
    });
  });

  it('does not turn missing or malformed evidence into merged proof', async () => {
    await withRuns(async (root) => {
      await writeFile(join(root, 'queue/prompts/wait.md'), 'DEPENDENCY GATE: RQ-A\n');
      await writeFile(join(root, 'queue/ready.tsv'), [parked('PARKED-DEP.devin', 'RQ-WAIT', 'wait'), parked('PARKED-DEP.devin', 'RQ-UNKNOWN', 'missing')].join('\n'));
      for (const ledger of [null, '{broken\n', JSON.stringify({ event: 'finish', state: 'MERGED', job: 'RQ-A' })]) {
        if (ledger !== null) await writeFile(join(root, 'metrics/jobs.jsonl'), ledger);
        const result = await readFleetQueue({ runsDir: root, now: () => now, depDetail: true });
        expect(result.unmetDeps).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-A'] }]);
        expect(result.metDeps).toEqual([]);
        expect(result.groups[0]?.count).toBe(2);
      }
    });
  });

  it('uses the bounded ledger tail and orders ready jobs by lane and file order', async () => {
    await withRuns(async (root) => {
      await writeFile(join(root, 'queue/prompts/wait.md'), 'DEPENDENCY GATE: RQ-OLD, RQ-NEW\n');
      await writeFile(join(root, 'queue/ready.tsv'), [ready('RQ-D1'), parked('PARKED-DEP.devin', 'RQ-WAIT', 'wait'), ready('RQ-C1', 'codex'), ready('RQ-D2'), ready('RQ-D3'), ready('RQ-D4')].join('\n'));
      const old = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-OLD' });
      const recent = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-NEW' });
      await writeFile(join(root, 'metrics/jobs.jsonl'), `${old}\n${'x'.repeat(2 * 1024 * 1024)}\n${recent}\n`);
      const result = await readFleetQueue({ runsDir: root, now: () => now, depDetail: true });
      expect(result.unmetDeps).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-OLD'] }]);
      expect(result.metDeps).toEqual([]);
      expect(result.nextUp).toEqual([{ lane: 'codex', jobs: ['RQ-C1'] }, { lane: 'devin', jobs: ['RQ-D1', 'RQ-D2', 'RQ-D3'] }]);
    });
  });
});
