import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEmpty } from '../src/core/fleet/empty-jobs.js';
import { cmdFleetRetryEmpty, planEmptyRetries } from '../src/cli/fleet-retry-empty.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const real = vi.hoisted(() => ({ readFile: undefined as unknown as typeof readFile, readdir: undefined as unknown as typeof readdir }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  real.readFile = mod.readFile;
  real.readdir = mod.readdir;
  return { ...mod, readFile: vi.fn(mod.readFile), readdir: vi.fn(mod.readdir) };
});

const ledger = (...ids: string[]) => ids.map(job => JSON.stringify({ event: 'outcome', empty: true, job, ts: new Date().toISOString(), lane: 'x' })).join('\n');
const entry = (id: string) => `- READY ${id} (P1, pool=codex-personal, tier=work, repo=phantom): Implement ${id} slice. Acceptance: tests pass.`;
const QUEUE = `${['RQ-TESTA', 'RQ-TESTB', 'RQ-TESTC', 'RQ-TESTD'].map(entry).join('\n')}\n`;

async function fixture(text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-retry-empty-'));
  const runs = join(dir, 'runs');
  await mkdir(join(runs, 'metrics'), { recursive: true });
  await mkdir(join(runs, 'queue'));
  await mkdir(join(dir, 'wt'));
  const file = join(runs, 'queue/router-queue.md');
  await writeFile(file, QUEUE);
  await writeFile(join(runs, 'metrics/jobs.jsonl'), text);
  return { dir, runs, file, receipts: join(runs, 'queue/empty-retry-receipts') };
}

async function withEnv<T>(runs: string, wt: string, fn: () => Promise<T>): Promise<T> {
  const oldRuns = process.env.ASHLR_RUNS_DIR, oldWt = process.env.ASHLR_WT_DIR;
  process.env.ASHLR_RUNS_DIR = runs;
  process.env.ASHLR_WT_DIR = wt;
  try { return await fn(); } finally {
    if (oldRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = oldRuns;
    if (oldWt === undefined) delete process.env.ASHLR_WT_DIR; else process.env.ASHLR_WT_DIR = oldWt;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readFile).mockImplementation(real.readFile);
  vi.mocked(readdir).mockImplementation(real.readdir);
});

describe('fleet retry-empty preservation', () => {
  it('resolves retry-empty to the convention module the fleet loader calls', async () => {
    const resolved = resolveFleetSubcommand('retry-empty');
    expect(resolved).toEqual({ module: './fleet-retry-empty.js', exportName: 'cmdFleetRetryEmpty' });
    const loaded = await import('../src/cli/fleet-retry-empty.js');
    expect(loaded[resolved!.exportName as keyof typeof loaded]).toBe(cmdFleetRetryEmpty);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetRetryEmpty(['--help'])).toBe(0);
  });

  it.each([
    ['Task is too broad', 'too-broad'],
    ['Tests timed out', 'tests-timeout'],
    ['The test suite is slow and timed out', 'tests-timeout'],
    ['No changes needed', 'already-done'],
    ['Duplicate of an earlier job', 'duplicate'],
  ])('classifies %s as %s', (text, kind) => {
    expect(classifyEmpty(text, null).class).toBe(kind);
  });

  it('plans only eligible jobs with their original route and a smaller goal', () => {
    const kinds = ['too broad', 'tests timed out', 'no changes needed', 'duplicate job'];
    const list = kinds.map((text, i) => ({ id: `RQ-TEST${'ABCD'[i]}`, lane: 'x', ...classifyEmpty(text, null) }));
    const lines = planEmptyRetries(QUEUE, list, new Set());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('repo=phantom');
    expect(lines[0]).toContain('pool=codex-personal');
    expect(lines[0]).toContain('tier=work');
    expect(lines[0]).toContain('one smallest independently shippable part');
    expect(lines[1]).toContain('Ship partial, list the gap');
    expect(lines[0]).toContain('retry-empty-source=RQ-TESTA');
  });

  it('skips ambiguous, unrouted, requeued and receipted sources', () => {
    const job = { id: 'RQ-TESTA', lane: 'x', ...classifyEmpty('too broad', null) };
    expect(planEmptyRetries(`${QUEUE}${entry('RQ-TESTA')}\n`, [job], new Set())).toHaveLength(0);
    expect(planEmptyRetries(QUEUE, [{ ...job, id: 'RQ-MISSING' }], new Set())).toHaveLength(0);
    expect(planEmptyRetries(QUEUE.replace('repo=phantom', 'tier=work'), [job], new Set())).toHaveLength(0);
    const ownRetry = QUEUE.replace('Acceptance: tests pass.', 'Acceptance: tests pass. retry-empty-source=RQ-OLDER');
    expect(planEmptyRetries(ownRetry, [job], new Set())).toHaveLength(0);
    const retryId = `RQ-EMPTYRETRY-${createHash('sha256').update('RQ-TESTA').digest('hex').slice(0, 20).toUpperCase()}`;
    const stillQueued = `${QUEUE}- READY ${retryId} (P1, pool=codex-personal, tier=work, repo=phantom): prior retry. retry-empty-source=RQ-TESTA\n`;
    expect(planEmptyRetries(stillQueued, [job], new Set())).toHaveLength(0);
    const receipted = new Set([createHash('sha256').update('RQ-TESTA').digest('hex')]);
    expect(planEmptyRetries(QUEUE, [job], receipted)).toHaveLength(0);
    const claimed = QUEUE.replace('- READY RQ-TESTA', '- CLAIMED codex-personal now RQ-TESTA');
    expect(planEmptyRetries(claimed, [job], new Set())).toHaveLength(1);
  });

  it('dry-run previews through the real handler and writes nothing', async () => {
    const { dir, runs, file, receipts } = await fixture(ledger('RQ-TESTA', 'RQ-TESTC'));
    await writeFile(join(runs, 'RQ-TESTA.log'), 'The task is too broad.');
    await writeFile(join(runs, 'RQ-TESTC.log'), 'The work is already done.');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const code = await withEnv(runs, join(dir, 'wt'), () => cmdFleetRetryEmpty(['--dry-run']));
      expect(code).toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('retry-empty-source=RQ-TESTA'));
      expect(await readFile(file, 'utf8')).toBe(QUEUE);
      expect(existsSync(receipts)).toBe(false);
      expect(existsSync(join(runs, 'queue/ready.lock'))).toBe(false);
    } finally {
      output.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies once and cannot enqueue again after the generated line is removed', async () => {
    const { dir, runs, file, receipts } = await fixture(ledger('RQ-TESTA'));
    await writeFile(join(runs, 'RQ-TESTA.log'), 'The task is too broad.');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await withEnv(runs, join(dir, 'wt'), async () => {
        expect(await cmdFleetRetryEmpty(['--apply'])).toBe(0);
        const applied = await readFile(file, 'utf8');
        expect(applied.match(/retry-empty-source=RQ-TESTA/g)).toHaveLength(1);
        expect(applied.startsWith(QUEUE)).toBe(true);
        expect(await readdir(receipts)).toHaveLength(1);
        await writeFile(file, QUEUE);
        expect(await cmdFleetRetryEmpty(['--apply'])).toBe(0);
        expect(await readFile(file, 'utf8')).toBe(QUEUE);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails a competing queue change without claiming success', async () => {
    const { dir, runs, file, receipts } = await fixture(ledger('RQ-TESTA'));
    await writeFile(join(runs, 'RQ-TESTA.log'), 'The task is too broad.');
    await writeFile(file, `${QUEUE}${entry('RQ-CONCURRENT')}\n`);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await withEnv(runs, join(dir, 'wt'), async () => {
        const stale = ((path: unknown, options?: unknown) =>
          String(path) === file ? Promise.resolve(QUEUE) : (real.readFile as (p: unknown, o?: unknown) => Promise<unknown>)(path, options)) as typeof readFile;
        vi.mocked(readFile).mockImplementation(stale);
        expect(await cmdFleetRetryEmpty(['--apply'])).toBe(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Could not update queue'));
        vi.mocked(readFile).mockImplementation(real.readFile);
        expect(await readFile(file, 'utf8')).toBe(`${QUEUE}${entry('RQ-CONCURRENT')}\n`);
        expect(existsSync(receipts)).toBe(false);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails a receipt planted between plan and write without enqueueing', async () => {
    const { dir, runs, file, receipts } = await fixture(ledger('RQ-TESTA'));
    await writeFile(join(runs, 'RQ-TESTA.log'), 'The task is too broad.');
    await mkdir(receipts);
    const planted = createHash('sha256').update('RQ-TESTA').digest('hex');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await withEnv(runs, join(dir, 'wt'), async () => {
        const racing = (async (path: unknown, options?: unknown) => {
          if (String(path) === receipts) { await writeFile(join(receipts, planted), ''); return [] as string[]; }
          return (real.readdir as (p: unknown, o?: unknown) => Promise<unknown>)(path, options);
        }) as typeof readdir;
        vi.mocked(readdir).mockImplementation(racing);
        expect(await cmdFleetRetryEmpty(['--apply'])).toBe(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Could not update queue'));
        expect((await readFile(file, 'utf8')).match(/retry-empty-source=RQ-TESTA/g)).toBeNull();
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a queue that is not a regular file', async () => {
    const { dir, runs } = await fixture(ledger('RQ-TESTA'));
    await writeFile(join(runs, 'RQ-TESTA.log'), 'The task is too broad.');
    const link = join(dir, 'linked-queue.md');
    await symlink(join(runs, 'queue/router-queue.md'), link);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = await withEnv(runs, join(dir, 'wt'), () => cmdFleetRetryEmpty(['--apply', '--file', link]));
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
