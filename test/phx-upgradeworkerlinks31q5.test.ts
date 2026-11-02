import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/worker-evidence-audit.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'worker-audit-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ps = (id: string, pid: number, lane = 'main') => `${pid} 00:10 /fake/bin/launch.sh ${id} phantom ${lane} work`;
async function fixture(id: string, lane = 'main', pid = 10) {
  await writeFile(join(dir, `${id}.launch`), `launched ${id} ${lane} pid ${pid} base abc1234\n`);
  await writeFile(join(dir, `${id}.base.meta`), `MODEL ${lane} work fake-model\n`);
  await writeFile(join(dir, `${id}.log`), 'FAKE-PRIVATE-LOG-CONTENT\n');
  await writeFile(join(dir, `${id}.prompt`), 'FAKE-PRIVATE-PROMPT-CONTENT\n');
  await writeFile(join(dir, `${id}.base`), 'abc1234 branch /fake/private/worktree\n');
}
function live(table: string) {
  return () => listLiveWorkers({ runPs: async () => table, now: () => 0 });
}
async function invoke(table: string, overrides: Parameters<typeof run>[1] = {}) {
  let output = '';
  const code = await run([], { live: live(table), detail: job => getFleetJobDetail(job, { runsDir: dir }),
    ...overrides, write: text => { output += text; } });
  return { code, output, body: JSON.parse(output) };
}

describe('worker evidence audit', () => {
  it('joins real reader projections, deduplicates wrappers and emits no private content', async () => {
    await fixture('JOB1');
    const read = vi.fn((job: string) => getFleetJobDetail(job, { runsDir: dir }));
    const { code, body, output } = await invoke([ps('JOB1', 11), ps('JOB1', 10)].join('\n'), { detail: read });
    expect(code).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ schema: 'worker-evidence-audit.v1', liveSource: 'healthy', omittedJobs: 0,
      workers: [{ job: 'JOB1', pid: 10, live: { lane: 'main', tier: 'work', state: 'running' },
        detail: { lane: 'main', tier: 'work', model: 'fake-model', state: 'running', sources: { launch: 'healthy', meta: 'healthy', log: 'healthy' } },
        comparisons: { lane: 'match', tier: 'match', state: 'match', model: 'unknown' } }] });
    expect(output).not.toContain('FAKE-PRIVATE');
    expect(output).not.toContain('/fake/');
    expect(output).not.toContain(dir);
  });

  it('retains other rows when a job disappears and one detail reader fails', async () => {
    await fixture('JOB1');
    await fixture('JOB2');
    const { code, body, output } = await invoke([ps('JOB1', 10), ps('JOB2', 20), ps('JOB3', 30)].join('\n'), {
      detail: async job => {
        if (job === 'JOB2') {
          await Promise.all(['launch', 'base.meta', 'log', 'base', 'prompt'].map(ext => rm(join(dir, `${job}.${ext}`))));
        }
        if (job === 'JOB3') throw new Error('/fake/private/error');
        return getFleetJobDetail(job, { runsDir: dir });
      },
    });
    expect(code).toBe(1);
    expect(body.workers).toHaveLength(3);
    expect(body.workers[0].detail.state).toBe('running');
    expect(body.workers[1]).toMatchObject({ job: 'JOB2', detail: { state: 'unknown', model: null, sources: { launch: 'missing', meta: 'missing' } }, comparisons: { lane: 'unknown', state: 'unknown' } });
    expect(body.workers[2]).toEqual({ job: 'JOB3', pid: 30, error: 'Detail unavailable.' });
    expect(output).not.toContain('/fake/');
    expect((await invoke(ps('JOB2', 20))).code).toBe(3);
  });

  it('reports lane, tier and state disagreements and degraded source health', async () => {
    await fixture('JOB1', 'other');
    await writeFile(join(dir, 'JOB1.base.meta'), 'MODEL other fast fake-model\n');
    const first = await invoke(ps('JOB1', 10));
    expect(first.code).toBe(1);
    expect(first.body.workers[0].comparisons).toMatchObject({ lane: 'mismatch', tier: 'mismatch' });
    await writeFile(join(dir, 'JOB1.publish'), 'RESULT PR https://example.invalid/1\n');
    const second = await invoke(ps('JOB1', 10));
    expect(second.body.workers[0].comparisons.state).toBe('mismatch');
    await fixture('JOB2');
    await rm(join(dir, 'JOB2.base'));
    await symlink(join(dir, 'outside'), join(dir, 'JOB2.base'));
    const degraded = await invoke(ps('JOB2', 20));
    expect(degraded.code).toBe(3);
    expect(degraded.body.workers[0].detail.sources.base).toBe('degraded');
  });

  it('bounds distinct jobs and detail concurrency while preserving snapshot order', async () => {
    await fixture('JOB0');
    const detail = await getFleetJobDetail('JOB0', { runsDir: dir });
    const table = Array.from({ length: 103 }, (_, i) => ps(`JOB${i}`, i + 1)).join('\n');
    let active = 0, peak = 0, calls = 0;
    const { code, body } = await invoke(table, { detail: async () => {
      calls++; active++; peak = Math.max(active, peak);
      await new Promise<void>(resolveWait => setImmediate(resolveWait));
      active--;
      return detail;
    } });
    expect(code).toBe(3);
    expect({ calls, peak, omitted: body.omittedJobs, length: body.workers.length }).toEqual({ calls: 100, peak: 2, omitted: 3, length: 100 });
    expect(body.workers.map((row: { job: string }) => row.job)).toEqual(Array.from({ length: 100 }, (_, i) => `JOB${i}`));
  });

  it('handles unavailable live source, no workers, unsafe model and static errors', async () => {
    const unavailable = await invoke('', { live: () => listLiveWorkers({ runPs: async () => { throw new Error('/fake/private'); } }) });
    expect(unavailable.code).toBe(1);
    expect(unavailable.output).not.toContain('/fake/');
    expect((await invoke('')).code).toBe(3);
    await fixture('JOB1');
    await writeFile(join(dir, 'JOB1.base.meta'), 'MODEL main work /fake/private/model\n');
    const unsafe = await invoke(ps('JOB1', 10));
    expect(unsafe.code).toBe(3);
    expect(unsafe.body.workers[0].detail.model).toBeNull();
    expect(unsafe.output).not.toContain('/fake/');
  });

  it('makes help and invalid usage side-effect free and guards the executable entrypoint', async () => {
    const read = vi.fn();
    let output = '';
    const deps = { live: read, detail: read, write: (text: string) => { output += text; } };
    expect(await run(['--help'], deps)).toBe(0);
    expect(output).toContain('Usage:');
    output = '';
    expect(await run(['--help', 'extra'], deps)).toBe(2);
    expect(JSON.parse(output)).toHaveProperty('error');
    expect(read).not.toHaveBeenCalled();
    const script = resolve('examples/upgrade/worker-evidence-audit.ts');
    const env = { HOME: dir, PATH: process.env.PATH };
    const help = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), script, '--help'], { env, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');
    const imported = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import ${JSON.stringify(script)}`], { env, encoding: 'utf8' });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
  }, 30_000);
});
