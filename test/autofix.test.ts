/**
 * KILL, idempotency, load renice and pinned-file detect-only.
 */
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/core/autofix/fixers.js';
import { createMemoryHost } from '../src/core/autofix/host.js';
import { incidentDir } from '../src/core/autofix/incidents.js';
import { runAutofix } from '../src/core/autofix/run.js';
import { emptySnapshot, type Proc } from '../src/core/autofix/types.js';
import { cmdAutofix } from '../src/cli/autofix.js';

function proc(partial: Partial<Proc> & Pick<Proc, 'pid' | 'comm'>): Proc {
  return { ppid: 1, uid: 501, nice: 0, dispatchdOwned: false, ...partial };
}

describe('autofix guards', () => {
  it('refuses the tick when KILL exists', async () => {
    const host = createMemoryHost();
    host.files.set(host.killPath(), '');
    host.dirs.set(incidentDir(host.runsDir()), ['INCIDENT-e_load.md']);
    const snapshot = emptySnapshot();
    snapshot.load1 = 40;
    snapshot.ncpu = 4;
    snapshot.processes = [proc({ pid: 90, comm: 'node' })];
    const result = await runAutofix({ host, snapshot, dryRun: false });
    expect(result).toMatchObject({ exitCode: 3, killed: true, lines: [], incidents: [] });
    expect(host.calls).toEqual([]);
  });

  it('renices outside load and skips dispatchd, the kernel and interactive apps', async () => {
    const host = createMemoryHost();
    host.dirs.set(incidentDir(host.runsDir()), ['INCIDENT-e_load.md']);
    const snapshot = emptySnapshot();
    snapshot.load1 = 20;
    snapshot.ncpu = 4;
    snapshot.processes = [
      proc({ pid: 1, comm: 'launchd' }),
      proc({ pid: 40, comm: 'dispatchd.py', dispatchdOwned: true }),
      proc({ pid: 41, comm: 'node', ppid: 40, dispatchdOwned: true }),
      proc({ pid: 70, comm: 'Cursor' }),
      proc({ pid: 80, comm: 'backupd' }),
      proc({ pid: 90, comm: 'node' }),
      proc({ pid: 91, comm: 'node', nice: 15 }),
    ];
    const result = await runAutofix({ host, snapshot, dryRun: false });
    expect(result.incidents[0]).toMatchObject({ key: 'e_load', status: 'fixed' });
    const reniced = host.calls.filter((argv) => argv[0] === 'renice');
    expect(reniced).toEqual([
      ['renice', '-n', '20', '-p', '80'],
      ['renice', '-n', '15', '-p', '90'],
    ]);
    expect(host.calls.some((argv) => /^(kill|pkill|killall)$/.test(argv[0] ?? ''))).toBe(false);
    const again = await runAutofix({ host, snapshot, dryRun: false });
    expect(again.incidents).toEqual([]);
    expect(host.calls.filter((argv) => argv[0] === 'renice')).toHaveLength(2);
  });

  it('reports a pinned hand edit and does not write the installed file', async () => {
    const host = createMemoryHost();
    const installed = '/tmp/autofix-runs/bin/publish.sh';
    host.files.set(installed, 'hand edited\n');
    const snapshot = emptySnapshot();
    snapshot.pinned = [{
      name: 'publish.sh',
      installedPath: installed,
      installedSha256: sha256Hex('hand edited\n'),
      expectedSha256: sha256Hex('pinned\n'),
    }];
    const result = await runAutofix({ host, snapshot, dryRun: false });
    expect(result.lines[0]).toMatchObject({ fixer: 'pinned-hand-edit', result: 'detect-only' });
    expect(host.files.get(installed)).toBe('hand edited\n');
    expect(host.writes.filter((path) => path === installed)).toEqual([]);
    expect([...host.files.values()].some((text) => text.includes('Hand edit detected'))).toBe(true);
  });

  it('dry-run does not kickstart or mark the incident fixed on disk', async () => {
    const host = createMemoryHost();
    host.dirs.set(incidentDir(host.runsDir()), ['INCIDENT-a_phantom_v3.30.35.md']);
    const lines: string[] = [];
    const code = await cmdAutofix(['--json'], {
      host,
      snapshot: emptySnapshot(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as { dryRun: boolean; incidents: { status: string }[] };
    expect(parsed.dryRun).toBe(true);
    expect(host.calls.some((argv) => argv[1] === 'kickstart')).toBe(false);
    expect(host.files.has('/tmp/autofix-runs/ledger/incidents.jsonl')).toBe(false);
  });
});
