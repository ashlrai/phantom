import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/host-preflight.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fake-preflight-'));
  roots.push(root);
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({
    last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
    lanes: { claude: { running: 0, target: 1, queued: 0, held: false } },
  }));
  await writeFile(join(root, 'metrics/jobs.jsonl'), '');
  await writeFile(join(root, 'metrics/api-spend.jsonl'), '');
  return root;
}
function adapters(root: string) {
  return {
    now: () => now,
    runs: () => readFleetRunsDirState({ runsDir: root, now: () => now }),
    workers: () => listLiveWorkers({ runPs: async () => '', now: () => now }),
    ledger: () => readResourceLedger({ runsDir: root, now: () => now, personalCodexHome: root }),
  };
}
async function invoke(deps: Parameters<typeof run>[1] = {}, args: string[] = []) {
  let output = '';
  const code = await run(args, { ...deps, write: text => { output += text; } });
  return { code, output, report: args.includes('--help') ? null : JSON.parse(output) };
}

describe('upgrade host preflight', () => {
  it('uses real readers on a fake runs root and reports healthy idle sources independently', async () => {
    const root = await fixture();
    const result = await invoke(adapters(root));
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ schema: 'host-preflight.v1', blockers: [],
      dispatch: { usable: true, rootPresent: true, rootHealth: 'degraded', lastTickAgeSeconds: 0, running: 0, sources: { status: 'healthy', claimed: 'missing' } },
      processes: { usable: true, source: 'healthy', state: 'idle', workers: 0, snapshotAgeSeconds: 0 },
      usage: { usable: true, sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'healthy' }, lastApiActivityAgeSeconds: null },
    });
    expect(result.output).not.toContain(root);
  });

  it('leaves healthy process visibility intact when the runs root is absent', async () => {
    const root = await fixture();
    const result = await invoke(adapters(join(root, 'absent')));
    expect(result.code).toBe(3);
    expect(result.report).toMatchObject({ dispatch: { rootPresent: false, usable: false },
      processes: { usable: true, state: 'idle' }, usage: { usable: false },
      blockers: ['dispatch-unavailable', 'usage-unavailable'] });
  });

  it('keeps the process table visible when status is broken', async () => {
    const root = await fixture();
    await writeFile(join(root, 'queue/status.json'), '{broken');
    const result = await invoke(adapters(root));
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ dispatch: { usable: false, sources: { status: 'degraded' }, running: null },
      processes: { usable: true, state: 'idle', workers: 0 }, usage: { usable: true, sources: { status: 'degraded' } } });
  });

  it('treats absent usage sources as insufficient, not zero usage', async () => {
    const root = await fixture();
    await rm(join(root, 'metrics/api-spend.jsonl'));
    const result = await invoke(adapters(root));
    expect(result.code).toBe(3);
    expect(result.report).toMatchObject({ dispatch: { usable: true }, processes: { state: 'idle' },
      usage: { usable: false, sources: { apiSpend: 'missing', jobs: 'healthy' } }, blockers: ['usage-unavailable'] });
  });

  it('isolates thrown readers, hides error text, and still calls the other readers', async () => {
    const root = await fixture();
    const base = adapters(root);
    for (const name of ['runs', 'workers', 'ledger'] as const) {
      const calls = { runs: vi.fn(base.runs), workers: vi.fn(base.workers), ledger: vi.fn(base.ledger) };
      calls[name].mockRejectedValue(new Error('fake private path and contents'));
      const result = await invoke({ ...calls, now: () => now });
      expect(result.code).toBe(1);
      expect(result.report.blockers).toContain('reader-failed');
      expect(result.output).not.toContain('fake private');
      expect(Object.values(calls).every(call => call.mock.calls.length === 1)).toBe(true);
      if (name !== 'workers') expect(result.report.processes.state).toBe('idle');
      if (name !== 'runs') expect(result.report.dispatch.usable).toBe(true);
      if (name !== 'ledger') expect(result.report.usage.usable).toBe(true);
    }
  });

  it('flags mismatch and active processes, and does not infer idle from a failed process reader', async () => {
    const root = await fixture();
    const base = adapters(root);
    const active = await invoke({ ...base, workers: () => listLiveWorkers({ now: () => now,
      runPs: async () => '123 00:10 /fake/bin/launch.sh JOB-FAKE phantom claude work\n' }) });
    expect(active.code).toBe(1);
    expect(active.report.blockers).toEqual(['worker-count-mismatch', 'processes-active']);
    const unavailable = await invoke({ ...base, workers: () => listLiveWorkers({ now: () => now,
      runPs: async () => { throw new Error('fake'); } }) });
    expect(unavailable).toMatchObject({ code: 1, report: { processes: { usable: false, state: 'unknown', workers: null } } });
  });

  it('rejects stale or future evidence and reports its age honestly', async () => {
    const root = await fixture();
    const base = adapters(root);
    const runs = await base.runs();
    runs.lastTick = new Date(now - 301_000).toISOString();
    const workers = await base.workers();
    workers.generatedAt = new Date(now + 1000).toISOString();
    const result = await invoke({ ...base, runs: async () => runs, workers: async () => workers });
    expect(result).toMatchObject({ code: 3, report: { dispatch: { usable: false, lastTickAgeSeconds: 301 },
      processes: { usable: false, snapshotAgeSeconds: null, state: 'unknown' } } });
  });

  it('handles help and usage without reading host sources', async () => {
    const read = vi.fn();
    const deps = { runs: read, workers: read, ledger: read, now: read };
    expect((await invoke(deps, ['--help'])).output).toContain('npx tsx examples/upgrade/host-preflight.ts');
    expect(await invoke(deps, ['--unknown'])).toMatchObject({ code: 2, report: { error: 'Invalid arguments. Use --help for usage.' } });
    expect(read).not.toHaveBeenCalled();
  });
});
