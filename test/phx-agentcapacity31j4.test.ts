import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCapacityReport } from '../examples/agents/capacity-report.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const roots: string[] = [];
const at = '2026-10-31T12:00:00Z';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'capacity-report-'));
  roots.push(root);
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({
    last_tick: at, paused: false, mem_free_pct: 50,
    lanes: {
      claude: { running: 1, target: 3, queued: 2, held: true, held_reason: 'maintenance' },
      'codex-personal': { running: 0, target: 2, queued: 1, held: false },
    },
    budget: { claude: { weekly_used_pct: 45, source: 'local observation' }, extra: { credits_remaining: 7 } },
  }));
  await writeFile(join(root, 'metrics/jobs.jsonl'), JSON.stringify({ job: 'job1', ts: at, lane: 'claude', event: 'finish', tokens_total: 123, empty: false, exit_code: 0 }) + '\n');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function invoke(args: string[], overrides: Parameters<typeof runCapacityReport>[1] = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCapacityReport(args, { ...overrides, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe('agent capacity report', () => {
  it('reports held lanes, source health, and unknown dispatch data for budget-only lanes', async () => {
    const root = await fixture();
    const result = await invoke(['--runs-dir', root]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ v: 1, observation: {
      runs: { lastTick: at, sourceState: 'degraded', sources: { status: 'healthy', metrics: 'healthy', claimed: 'missing' } },
      ledger: { asOf: at, sources: { status: 'healthy', jobs: 'healthy', apiSpend: 'missing' } }, paused: false,
    } });
    expect(report.lanes.map((lane: { lane: string }) => lane.lane)).toEqual(['claude', 'codex-personal', 'extra']);
    expect(report.lanes[0]).toMatchObject({ lane: 'claude', join: 'matched', running: 1, target: 3, queued: 2, held: true, heldReason: 'maintenance', usage: { window: 'weekly', usedPct: 45, source: 'local observation' } });
    expect(report.lanes[2]).toMatchObject({ lane: 'extra', join: 'unknown', running: null, target: null, queued: null, held: null, usage: { creditsRemaining: 7, tokensLastHour: null } });
    expect(result.stdout).not.toMatch(/"[^"]*(?:5h|fiveHour)[^"]*"\s*:/i);
  });

  it('identifies mismatched observations and does not invent missing ledger joins', async () => {
    const root = await fixture();
    const runs = await readFleetRunsDirState({ runsDir: root });
    const ledger = await readResourceLedger({ runsDir: root });
    ledger.asOf = '2026-10-31T12:01:00Z';
    ledger.lanes = ledger.lanes.filter(lane => lane.lane !== 'codex-personal');
    const result = await invoke([], { runs: async () => runs, ledger: async () => ledger });
    const report = JSON.parse(result.stdout);
    expect(report.lanes[0]).toMatchObject({ lane: 'claude', join: 'mismatched', held: true });
    expect(report.lanes[1]).toMatchObject({ lane: 'codex-personal', join: 'unknown', running: 0, queued: 1, usage: null });
    ledger.asOf = at;
    ledger.lanes[0]!.held = false;
    const conflict = await invoke([], { runs: async () => runs, ledger: async () => ledger });
    expect(JSON.parse(conflict.stdout).lanes[0].join).toBe('mismatched');
    ledger.asOf = null;
    const unknown = await invoke([], { runs: async () => runs, ledger: async () => ledger });
    expect(JSON.parse(unknown.stdout).lanes[0].join).toBe('unknown');
  });

  it('retains reader validation for missing, malformed and symlinked sources', async () => {
    const root = await fixture();
    const status = join(root, 'queue/status.json');
    await writeFile(status, '{invalid');
    let report = JSON.parse((await invoke(['--runs-dir', root])).stdout);
    expect(report.observation.runs.sources.status).toBe('degraded');
    expect(report.observation.ledger.sources.status).toBe('degraded');
    expect(report.lanes).toEqual([]);
    await rm(status);
    await symlink(join(root, 'metrics/jobs.jsonl'), status);
    report = JSON.parse((await invoke(['--runs-dir', root])).stdout);
    expect(report.observation.runs.sources.status).toBe('degraded');
    expect(report.observation.ledger.sources.status).toBe('degraded');
    await rm(status);
    report = JSON.parse((await invoke(['--runs-dir', root])).stdout);
    expect(report.observation.runs.sources.status).toBe('missing');
    expect(report.observation.ledger.sources.status).toBe('missing');
  });

  it('provides help and rejects invalid arguments without reading sources', async () => {
    const runs = vi.fn(readFleetRunsDirState);
    const ledger = vi.fn(readResourceLedger);
    const help = await invoke(['--help'], { runs, ledger });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('npx tsx examples/agents/capacity-report.ts');
    for (const args of [['--runs-dir'], ['--unknown'], ['--runs-dir', 'a', '--runs-dir', 'b'], ['--help', '--unknown']]) {
      const bad = await invoke(args, { runs, ledger });
      expect(bad).toMatchObject({ code: 2, stdout: '' });
      expect(bad.stderr).toContain('Invalid arguments');
    }
    expect(runs).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  it('returns a generic error if either reader throws', async () => {
    const root = await fixture();
    const runs = await readFleetRunsDirState({ runsDir: root });
    const ledger = await readResourceLedger({ runsDir: root });
    for (const failing of ['runs', 'ledger'] as const) {
      const result = await invoke([], { runs: async () => runs, ledger: async () => ledger, [failing]: async () => { throw new Error('private source contents'); } });
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'Unable to read capacity report.\n' });
    }
  });
});
