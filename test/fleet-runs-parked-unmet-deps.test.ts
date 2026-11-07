import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergedJobsFromJsonl,
  parseDependencyGateIds,
  readFleetQueue,
} from '../src/core/fleet/runs-parked-queue.js';
import { fleetStatusApi } from '../src/core/fleet/status-api.js';

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

describe('fleet parked unmet deps prompt path safety (RQ-SWE3-SEC-PATHS-1)', () => {
  const row = (promptPath: string, job = 'RQ-WAIT') =>
    `PARKED-DEP.devin\t${job}\tdevin\twork\tphantom\t${promptPath}`;

  async function seed() {
    const base = await mkdtemp(join(tmpdir(), 'fleet-unmet-deps-sec-'));
    const runsDir = join(base, 'runs');
    const outside = join(base, 'outside');
    await mkdir(join(runsDir, 'queue', 'prompts'), { recursive: true });
    await mkdir(join(runsDir, 'metrics'), { recursive: true });
    await mkdir(outside, { recursive: true });
    return { base, runsDir, outside };
  }

  it('rejects absolute prompt paths that escape the runs dir via ..', async () => {
    const { base, runsDir, outside } = await seed();
    try {
      await writeFile(join(outside, 'leak.md'), 'DEPENDENCY GATE: RQ-LEAK\n');
      // The raw absolute path still carries the runs dir as a string prefix.
      await writeFile(join(runsDir, 'queue', 'ready.tsv'), `${row(`${runsDir}/../outside/leak.md`)}\n`);
      const result = await readFleetQueue({ runsDir, now: () => now });
      expect(result.unmetDeps).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('RQ-LEAK');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects queue-relative prompt paths that escape the runs dir via ..', async () => {
    const { base, runsDir, outside } = await seed();
    try {
      await writeFile(join(outside, 'leak.md'), 'DEPENDENCY GATE: RQ-LEAK\n');
      await writeFile(join(runsDir, 'queue', 'ready.tsv'), `${row('../../outside/leak.md')}\n`);
      const result = await readFleetQueue({ runsDir, now: () => now });
      expect(result.unmetDeps).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('RQ-LEAK');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked final component that resolves outside the runs dir', async () => {
    const { base, runsDir, outside } = await seed();
    try {
      const target = join(outside, 'secret.md');
      await writeFile(target, 'DEPENDENCY GATE: RQ-LEAK\n');
      await symlink(target, join(runsDir, 'queue', 'prompts', 'evil.md'));
      await writeFile(join(runsDir, 'queue', 'ready.tsv'),
        `${row('prompts/evil.md')}\n${row(join(runsDir, 'queue', 'prompts', 'evil.md'), 'RQ-WAIT-2')}\n`);
      const result = await readFleetQueue({ runsDir, now: () => now });
      expect(result.unmetDeps).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('RQ-LEAK');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not follow an in-root symlinked directory that resolves outside the runs dir', async () => {
    const { base, runsDir, outside } = await seed();
    try {
      const pool = join(outside, 'pool');
      await mkdir(pool);
      await writeFile(join(pool, 'x.md'), 'DEPENDENCY GATE: RQ-LEAK\n');
      await symlink(pool, join(runsDir, 'queue', 'pool'));
      await writeFile(join(runsDir, 'queue', 'ready.tsv'), `${row('pool/x.md')}\n`);
      const result = await readFleetQueue({ runsDir, now: () => now });
      expect(result.unmetDeps).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('RQ-LEAK');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reads only the first 64 KiB of an oversized in-root prompt', async () => {
    const { base, runsDir } = await seed();
    try {
      const body = `DEPENDENCY GATE: RQ-BIG\n${'x'.repeat(256 * 1024)}`;
      await writeFile(join(runsDir, 'queue', 'prompts', 'big.md'), body);
      await writeFile(join(runsDir, 'queue', 'ready.tsv'), `${row('prompts/big.md')}\n`);
      const result = await readFleetQueue({ runsDir, now: () => now });
      expect(result.unmetDeps).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-BIG'] }]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('ignores prompt paths that are not regular files', async () => {
    const { base, runsDir } = await seed();
    try {
      await writeFile(join(runsDir, 'queue', 'ready.tsv'),
        `${row('prompts')}\n${row('prompts/missing.md', 'RQ-WAIT-2')}\n`);
      const result = await readFleetQueue({ runsDir, now: () => now });
      expect(result.unmetDeps).toEqual([]);
      expect(result.parked).toBe(2);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reaches the reader through the status API without leaking outside files', async () => {
    const { base, runsDir, outside } = await seed();
    try {
      const target = join(outside, 'secret.md');
      await writeFile(target, 'DEPENDENCY GATE: RQ-LEAK\n');
      await symlink(target, join(runsDir, 'queue', 'prompts', 'evil.md'));
      await writeFile(join(runsDir, 'queue', 'ready.tsv'), `${row('prompts/evil.md')}\n`);
      const status = await fleetStatusApi(runsDir, () => now);
      expect(status.queue).toEqual({ ready: 0, parked: 1 });
      expect(JSON.stringify(status)).not.toContain('RQ-LEAK');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
