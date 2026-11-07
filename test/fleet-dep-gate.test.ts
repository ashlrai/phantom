import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetDepGate } from '../src/cli/fleet-dep-gate.js';
import { readDepGate } from '../src/core/fleet/dep-gate.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const mergedRow = (job: string) => JSON.stringify({ event: 'outcome', state: 'MERGED', job });

interface Fixture { dir: string; cleanup: () => Promise<void> }

/** runsDir/queue/ready.tsv + queue/prompts/* + metrics/jobs.jsonl fixture. */
async function makeRunsDir(opts: {
  ready: string[];
  prompts?: Record<string, string>;
  jobs?: string[];
}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-dep-gate-'));
  await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
  await mkdir(join(dir, 'metrics'), { recursive: true });
  await writeFile(join(dir, 'queue', 'ready.tsv'), opts.ready.join('\n') + '\n');
  for (const [name, body] of Object.entries(opts.prompts ?? {})) {
    await writeFile(join(dir, 'queue', 'prompts', name), body);
  }
  await writeFile(join(dir, 'metrics', 'jobs.jsonl'), (opts.jobs ?? []).join('\n') + '\n');
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runCli(args: string[]) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetDepGate(args);
  return { code, lines: out.mock.calls.map((call) => String(call[0])) };
}

describe('fleet dep-gate (RQ-DEPGATEQ8)', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['dep-gate']!()).cmdFleetDepGate).toBe(cmdFleetDepGate);
  });

  it('lists every gate id with no MERGED outcome and exits 1', async () => {
    const { dir, cleanup } = await makeRunsDir({
      ready: [
        'RQ-WAIT\tphantom\tdevin\twork\tprompts/RQ-WAIT.md',
        'RQ-FREE\tphantom\tdevin\twork\tprompts/RQ-FREE.md',
      ],
      prompts: {
        'RQ-WAIT.md': 'Job RQ-WAIT.\n\nDEPENDENCY GATE: RQ-UP-A, RQ-UP-B\n\nno merge without Security pin\n',
        'RQ-FREE.md': 'Job RQ-FREE. No gate here.\n',
      },
      jobs: [mergedRow('RQ-UP-A')],
    });
    try {
      const { code, lines } = await runCli(['--runs-dir', dir]);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('UNMET-DEP RQ-WAIT (devin): RQ-UP-B');
      const report = await readDepGate({ runsDir: dir });
      expect(report.unmet).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-UP-B'] }]);
      expect(report.gated).toBe(1);
      expect(JSON.stringify(report)).not.toContain('no merge without Security pin');
      expect(JSON.stringify(report)).not.toContain(dir);
    } finally {
      await cleanup();
    }
  });

  it('exits 0 when every gate id is MERGED and reports --json', async () => {
    const { dir, cleanup } = await makeRunsDir({
      ready: ['RQ-WAIT\tphantom\tdevin\twork\tprompts/RQ-WAIT.md'],
      prompts: { 'RQ-WAIT.md': 'DEPENDENCY GATE: RQ-UP-A, RQ-UP-B\n' },
      jobs: [mergedRow('RQ-UP-A'), mergedRow('RQ-UP-B'),
        JSON.stringify({ event: 'finish', state: 'MERGED', job: 'RQ-NOT-OUTCOME' })],
    });
    try {
      const { code, lines } = await runCli(['--json', '--runs-dir', dir]);
      expect(code).toBe(0);
      const report = JSON.parse(lines[0]!);
      expect(report.v).toBe(1);
      expect(report.sources).toEqual({ ready: 'healthy', jobs: 'healthy' });
      expect(report.rows).toBe(1);
      expect(report.gated).toBe(1);
      expect(report.unmet).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('skips PARKED rows in both layouts even when gate ids are unmet', async () => {
    const { dir, cleanup } = await makeRunsDir({
      ready: [
        'RQ-PARKED-LANE\tphantom\tPARKED-DEP.devin\twork\tprompts/gated.md',
        'PARKED-DEP.devin\tRQ-PARKED-FIRST\tdevin\twork\tphantom\tprompts/gated.md',
        'RQ-READY\tphantom\tdevin\twork\tprompts/plain.md',
      ],
      prompts: {
        'gated.md': 'DEPENDENCY GATE: RQ-NEVER-MERGED\n',
        'plain.md': 'Job RQ-READY, no gate.\n',
      },
    });
    try {
      const report = await readDepGate({ runsDir: dir });
      expect(report.rows).toBe(1);
      expect(report.gated).toBe(0);
      expect(report.unmet).toEqual([]);
      expect(await runCli(['--runs-dir', dir])).toMatchObject({ code: 0 });
    } finally {
      await cleanup();
    }
  });

  it('reads the prompt at column 6 for status-first READY rows', async () => {
    const { dir, cleanup } = await makeRunsDir({
      ready: ['READY\tRQ-WAIT\tdevin\twork\tphantom\tprompts/gated.md'],
      prompts: { 'gated.md': 'DEPENDENCY GATE: RQ-UP-A\n' },
    });
    try {
      const report = await readDepGate({ runsDir: dir });
      expect(report.unmet).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-UP-A'] }]);
    } finally {
      await cleanup();
    }
  });

  it('fails when a gated row has no jobs.jsonl at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-dep-gate-'));
    try {
      await mkdir(join(dir, 'queue', 'prompts'), { recursive: true });
      await writeFile(join(dir, 'queue', 'prompts', 'gated.md'), 'DEPENDENCY GATE: RQ-UP-A\n');
      await writeFile(join(dir, 'queue', 'ready.tsv'), 'RQ-WAIT\tphantom\tdevin\twork\tprompts/gated.md\n');
      const report = await readDepGate({ runsDir: dir });
      expect(report.sources.jobs).toBe('missing');
      expect(report.unmet).toEqual([{ job: 'RQ-WAIT', lane: 'devin', unmet: ['RQ-UP-A'] }]);
      expect(await runCli(['--runs-dir', dir])).toMatchObject({ code: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores prompt paths outside the runs dir and unreadable prompts', async () => {
    const { dir, cleanup } = await makeRunsDir({
      ready: [
        'RQ-ESCAPE\tphantom\tdevin\twork\t/etc/passwd',
        'RQ-TRAVERSE\tphantom\tdevin\twork\t../../etc/passwd',
        'RQ-MISSING\tphantom\tdevin\twork\tprompts/absent.md',
      ],
    });
    try {
      const report = await readDepGate({ runsDir: dir });
      expect(report.gated).toBe(0);
      expect(report.unmet).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('honors ASHLR_RUNS_DIR over the default root', async () => {
    const { dir, cleanup } = await makeRunsDir({
      ready: ['RQ-WAIT\tphantom\tdevin\twork\tprompts/gated.md'],
      prompts: { 'gated.md': 'DEPENDENCY GATE: RQ-UP-A\n' },
    });
    try {
      vi.stubEnv('ASHLR_RUNS_DIR', dir);
      const { code } = await runCli([]);
      expect(code).toBe(1);
      const report = await readDepGate();
      expect(report.unmet[0]?.job).toBe('RQ-WAIT');
    } finally {
      await cleanup();
    }
  });

  it('exits 0 with a missing ready.tsv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-dep-gate-'));
    try {
      const report = await readDepGate({ runsDir: dir });
      expect(report.sources.ready).toBe('missing');
      expect(report.unmet).toEqual([]);
      const { code, lines } = await runCli(['--runs-dir', dir]);
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('dep-gate: clear');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['--bogus'],
    ['--runs-dir'],
    ['--runs-dir', 'relative'],
    ['--json', '--json'],
  ])('rejects invalid arguments %j', async (...args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetDepGate(args)).toBe(2);
    expect(error).toHaveBeenCalledWith('Usage: ashlr fleet dep-gate [--json] [--runs-dir <abs>]');
  });

  it('prints usage and exits 0 on --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetDepGate(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith('Usage: ashlr fleet dep-gate [--json] [--runs-dir <abs>]');
  });
});
