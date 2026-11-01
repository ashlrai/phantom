import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPlannerCycle } from '../src/cli/fleet-planner-cycle.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { PlannerCycleDeps } from '../src/core/fleet/planner-cycle.js';
import type { PlannerRunResult } from '../src/core/fleet/planner-run.js';

let dir: string, busRoot: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cycle-bus-')); busRoot = join(dir, 'bus'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture(exitCode = 0, pending = 1) {
  const result: PlannerRunResult = {
    v: 1, provider: 'claude', outcome: 'ran', exitCode, logPath: '/private/log',
    startedAt: '2026-11-01T00:08:00Z', finishedAt: '2026-11-01T00:08:01Z',
    nextResetAt: null, planError: null,
  };
  const executePass = vi.fn<PlannerCycleDeps['executePass']>().mockResolvedValue({
    ok: true, provider: 'claude', reason: 'private reason', result,
  });
  const readOutput = vi.fn<PlannerCycleDeps['readOutput']>().mockResolvedValue({
    v: 1, window: { since: 's', until: 'u' }, ingested: [],
    pending: pending ? [{ id: 'private-job', dropDir: '/private/drop', ageSeconds: 1 }] : [],
    rejected: [{ id: 'private-rejected', reason: 'private rejection', at: 'a' }],
    counts: { ingested: 0, pending, rejected: 1 },
    sources: { ledger: 'ok', drops: [{ dir: '/private/drop', state: 'ok' }], skipped: 0 },
  });
  return { executePass, readOutput };
}
const base = ['--prompt-file', '/private/prompt', '--runs-root', '/private/runs', '--json'];
const route = ['--run-id', 'run-1', '--from', 'leader', '--to', 'next'];
async function run(args: string[], deps = fixture(), root = busRoot) {
  let out = '', err = '';
  const code = await cmdFleetPlannerCycle(args, {
    deps, stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } },
  }, { root, now: () => 1000 });
  return { code, out, err, deps };
}
function messages() {
  const page = listBusInboxAfter(0, 50, { root: busRoot, now: () => 1000 });
  if (page.status !== 'ok') throw new Error(page.status);
  return page.messages;
}

describe('planner cycle bus result', () => {
  it('posts one bounded observational result after exactly one productive pass', async () => {
    const r = await run([...base, ...route, '--apply']);
    expect(r.code).toBe(0);
    expect(r.deps.executePass).toHaveBeenCalledOnce();
    expect(r.deps.readOutput).toHaveBeenCalledOnce();
    expect(JSON.parse(r.out)).toMatchObject({ report: { verdict: 'productive' }, delivery: { status: 'posted' } });
    const rows = messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope).toMatchObject({ from: 'leader', to: 'next', body: {
      schema: 'planner-cycle-result.v1', runId: 'run-1', verdict: 'productive',
      execution: { outcome: 'ran', provider: 'claude', exitCode: 0 },
      evidence: { state: 'productive', counts: { ingested: 0, pending: 1, rejected: 1 }, attribution: 'observational' },
    } });
    const payload = JSON.stringify(rows[0]!.envelope.body);
    for (const forbidden of ['private', 'prompt', 'log', 'path', 'reason', 'job', 'drop', 'source', 'window']) {
      expect(payload).not.toContain(forbidden);
    }
  });

  it.each([
    [7, 1, 'failed', 1], [0, 0, 'unproductive', 1],
  ])('publishes the actual non-success verdict for exit %i and count %i', async (exit, pending, verdict, code) => {
    const r = await run([...base, ...route, '--apply'], fixture(exit, pending));
    expect(r.code).toBe(code);
    expect(r.deps.executePass).toHaveBeenCalledOnce();
    expect(JSON.parse(r.out)).toMatchObject({ report: { verdict }, delivery: { status: 'posted' } });
    expect(messages()[0]!.envelope.body).toMatchObject({ verdict, execution: { exitCode: exit } });
  });

  it.each(['skipped', 'unknown'] as const)('delivers %s without reporting success', async verdict => {
    const d = fixture();
    if (verdict === 'skipped') {
      const pass = await d.executePass({ runsRoot: '/runs', promptPath: '/prompt', run: true });
      if (!('result' in pass) || !pass.result) throw new Error('missing fixture result');
      d.executePass.mockResolvedValue({ ...pass, result: { ...pass.result, outcome: 'skipped-orch-off' } });
      d.executePass.mockClear();
    } else {
      d.readOutput.mockRejectedValue(new Error('private error'));
    }
    const r = await run([...base, ...route, '--apply'], d);
    expect(r.code).toBe(verdict === 'skipped' ? 3 : 4);
    expect(d.executePass).toHaveBeenCalledOnce();
    expect(messages()[0]!.envelope.body).toMatchObject({ verdict, evidence: { attribution: 'observational' } });
    expect(JSON.parse(r.out).delivery.status).toBe('posted');
  });

  it('returns nonzero for a productive cycle whose result conflicts', async () => {
    await run([...base, ...route, '--apply'], fixture(1));
    const r = await run([...base, ...route, '--apply']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ report: { verdict: 'productive' }, delivery: { status: 'conflict' } });
    expect(r.deps.executePass).toHaveBeenCalledOnce();
  });

  it('classifies identical publication as duplicate and a changed result as conflict', async () => {
    expect((await run([...base, ...route, '--apply'])).code).toBe(0);
    const duplicate = await run([...base, ...route, '--apply']);
    expect(duplicate.code).toBe(0);
    expect(duplicate.deps.executePass).toHaveBeenCalledOnce();
    expect(JSON.parse(duplicate.out).delivery).toEqual({ status: 'duplicate' });
    const conflict = await run([...base, ...route, '--apply'], fixture(1));
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.out)).toMatchObject({ report: { verdict: 'failed' }, delivery: { status: 'conflict' } });
    expect(messages()).toHaveLength(1);
  });

  it('fails a productive cycle when storage is unavailable while preserving its report', async () => {
    await writeFile(busRoot, 'not a directory');
    const r = await run([...base, ...route, '--apply']);
    expect(r.code).toBe(1);
    expect(r.deps.executePass).toHaveBeenCalledOnce();
    expect(JSON.parse(r.out)).toMatchObject({ report: { verdict: 'productive', execution: { exitCode: 0 },
      evidence: { counts: { pending: 1 } } }, delivery: { status: 'unavailable' } });
  });

  it('previews without calling either dependency or creating the bus', async () => {
    const r = await run([...base, ...route]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ report: null, delivery: { status: 'preview' } });
    expect(r.deps.executePass).not.toHaveBeenCalled();
    expect(r.deps.readOutput).not.toHaveBeenCalled();
    expect(existsSync(busRoot)).toBe(false);
  });

  it.each([
    ['--run-id', 'run-1'], ['--from', 'leader', '--to', 'next'],
    ['--run-id', 'bad/id', '--from', 'leader', '--to', 'next'],
    ['--run-id', 'run-1', '--from', 'bad address', '--to', 'next'],
    [...route, '--root', 'relative'], [...route, '--from', 'again'],
  ])('rejects partial or invalid routing before any side effects: %s', async (...args) => {
    const r = await run([...base, ...args, '--apply']);
    expect(r.code).toBe(2);
    expect(r.deps.executePass).not.toHaveBeenCalled();
    expect(r.deps.readOutput).not.toHaveBeenCalled();
    expect(existsSync(busRoot)).toBe(false);
  });

  it('accepts a bus root flag and explains the dedupe limit in local help', async () => {
    const r = await run([...base, ...route, '--root', busRoot, '--apply'], fixture(), join(dir, 'other'));
    expect(r.code).toBe(0);
    expect(messages()).toHaveLength(1);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--run-id');
    expect(help.out).toContain('Rerunning may execute another pass');
    expect(help.out).toContain('authenticate nobody');
  });
});
