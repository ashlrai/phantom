import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK_FANOUT_N, fanoutAskV1, parseAskV1, type AskTier } from '../src/core/ask/fanout.js';
import { routerQueueAskFanout, routerQueueRoot } from '../src/core/fleet/router-queue.js';
import { projectDriveQueueV1 } from '../src/core/drive/queue-v1.js';
import { cmdRouterQueue } from '../src/cli/router-queue.js';

const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md'].map((name) => `ashlrai/${name}`);
const allowed = new Set(repos);
const ask = (patch: Record<string, unknown> = {}) => ({
  schema: 'ask.v1', id: 'ASK-V4-FANOUT-1', tier: 'mid', pool: 'devin', priority: 'P1',
  repos: [repos[0], repos[2], repos[4]], task: 'Split the V4 ask across repos.', ...patch,
});

describe('ask.v1 parse', () => {
  it('accepts a well-formed record verbatim', () => {
    expect(parseAskV1(ask())).toEqual({ ...ask(), tier: 'mid' });
  });

  it.each([
    null, undefined, [], 'ask', { ...ask(), extra: true }, { schema: 'ask.v2' },
    { id: 'has spaces' }, { id: '' }, { tier: 'local' }, { tier: 'WORK' },
    { pool: 'Devin' }, { pool: '' }, { priority: 'p1' }, { priority: 'P10' },
    { repos: [] }, { repos: [repos[0], repos[0]] }, { repos: ['phantom'] },
    { repos: ['other/phantom'] }, { task: '' }, { task: '  ' },
    { task: 'x'.repeat(8_001) }, { task: 'bad\x07task' }, { task: 'nul\x00byte' },
  ])('rejects malformed or out-of-contract input %j', (patch) => {
    const value = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
      ? { ...ask(), ...(patch as object) } : patch;
    expect(() => parseAskV1(value)).toThrow('Invalid ask.v1');
  });
});

describe('ask.v1 fanout', () => {
  it.each([['work', 1], ['mid', 2], ['frontier', 3]] as [AskTier, number][])(
    'splits a %s ask into %i queue.v1 jobs', (tier, n) => {
      const result = fanoutAskV1(ask({ tier }), allowed);
      expect(result.schema).toBe('queue.v1');
      expect(result.jobs).toHaveLength(n);
      expect(result.jobs).toHaveLength(ASK_FANOUT_N[tier]);
    });

  it('emits one distinct repo per job, first N listed, as queue.v1 short names', () => {
    const result = fanoutAskV1(ask({ tier: 'frontier' }), allowed);
    expect(result.jobs.map((job) => job.repo)).toEqual(['phantom', 'locus', 'ashlr-stack']);
    expect(new Set(result.jobs.map((job) => job.repo)).size).toBe(3);
  });

  it('propagates routing fields, starts every job READY with no deps and deterministic ids', () => {
    const result = fanoutAskV1(ask({ tier: 'frontier' }), allowed);
    for (const job of result.jobs) {
      expect(job).toMatchObject({ status: 'READY', priority: 'P1', pool: 'devin', tier: 'frontier', deps: [], task: ask().task });
      expect(job.id).toMatch(/^RQ-[a-f0-9]{24}$/);
    }
    expect(new Set(result.jobs.map((job) => job.id)).size).toBe(3);
    expect(fanoutAskV1(ask({ tier: 'frontier' }), allowed)).toEqual(result);
    expect(fanoutAskV1(ask({ tier: 'frontier', id: 'ASK-V4-FANOUT-2' }), allowed).jobs.map((job) => job.id))
      .not.toEqual(result.jobs.map((job) => job.id));
  });

  it('refuses a tier whose fanout exceeds the listed repos', () => {
    expect(() => fanoutAskV1(ask({ tier: 'frontier', repos: [repos[0], repos[2]] }), allowed)).toThrow('requires 3 repos');
    expect(() => fanoutAskV1(ask({ tier: 'mid', repos: [repos[0]] }), allowed)).toThrow('requires 2 repos');
  });

  it('refuses repos outside the configured allowlist, even unselected ones', () => {
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `ashlrai/${name}`);
    expect(() => fanoutAskV1(ask({ tier: 'work', repos: [repos[0], 'ashlrai/not-configured'] }), allowed)).toThrow('not configured');
    expect(() => fanoutAskV1(ask({ tier: 'work', repos: seven }), allowed)).toThrow('not configured');
    expect(fanoutAskV1(ask({ tier: 'work' }), new Set(seven.concat(repos)))).toBeDefined();
  });

  it('projects through the DRIVER-1 scheduling seam as launchable READY work', () => {
    const projected = projectDriveQueueV1(fanoutAskV1(ask({ tier: 'frontier' }), allowed));
    expect(projected.map((job) => job.state)).toEqual(['READY', 'READY', 'READY']);
    expect(projected.every((job) => job.priority > 0)).toBe(true);
  });
});

describe('router-queue ask wiring', () => {
  let home: string;
  let root: string;
  const originalHome = process.env['HOME'];
  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'ask-fanout-'));
    process.env['HOME'] = home;
    root = routerQueueRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ v: 1, repositories: repos }), { mode: 0o600 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('fans an ask out over configured repositories without touching queue state', () => {
    const result = routerQueueAskFanout(ask({ tier: 'work' }));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.repo).toBe('phantom');
    expect(existsSync(join(root, 'state.json'))).toBe(false);
    expect(existsSync(join(root, 'router-queue.md'))).toBe(false);
    expect(existsSync(join(root, 'read-diffs.jsonl'))).toBe(false);
  });

  it('fails closed when the queue is unconfigured or the ask is out of scope', () => {
    expect(() => routerQueueAskFanout(ask({ tier: 'work', repos: ['ashlrai/not-configured'] }))).toThrow();
    expect(() => routerQueueAskFanout(null)).toThrow();
    rmSync(join(root, 'config.json'));
    expect(() => routerQueueAskFanout(ask())).toThrow();
  });

  it('serves the ask verb over stdin without echoing bad input', async () => {
    const run = async (args: string[], input = '') => {
      const output: unknown[] = [];
      const code = await cmdRouterQueue(args, { input: (async function* () { yield input; })(), output: (value) => output.push(value) });
      return { code, output };
    };
    const ok = await run(['ask', '--json'], JSON.stringify(ask({ tier: 'mid' })));
    expect(ok.code).toBe(0);
    const doc = ok.output[0] as { schema: string; jobs: { repo: string }[] };
    expect(doc.schema).toBe('queue.v1');
    expect(doc.jobs.map((job) => job.repo)).toEqual(['phantom', 'locus']);
    for (const input of ['not json', '{"schema":"ask.v1"}', 'x'.repeat(16 * 1024 + 1)]) {
      expect(await run(['ask'], input)).toEqual({ code: 1, output: [{ error: 'queue-unavailable-or-invalid' }] });
    }
    expect((await run(['ask', '--help'])).code).toBe(0);
    expect((await run(['ask', 'pos-arg'])).code).toBe(2);
    expect(existsSync(join(root, 'state.json'))).toBe(false);
  });
});
