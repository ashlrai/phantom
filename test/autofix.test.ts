/**
 * KILL, idempotency, load renice and pinned-file detect-only.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectSnapshot } from '../src/core/autofix/collect.js';
import { sha256Hex } from '../src/core/autofix/fixers.js';
import { isForbiddenExecArgv } from '../src/core/autofix/guard.js';
import { createMemoryHost } from '../src/core/autofix/host.js';
import { incidentDir } from '../src/core/autofix/incidents.js';
import { launchAgentsDir } from '../src/core/autofix/launchd.js';
import { runAutofix } from '../src/core/autofix/run.js';
import { AUTOFIX_SCHEMA, emptySnapshot, type Proc } from '../src/core/autofix/types.js';
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
    const repeatDryRun = await runAutofix({ host, snapshot, dryRun: true });
    expect(repeatDryRun.lines[0]).toMatchObject({
      fixer: 'pinned-hand-edit',
      result: 'skipped',
      after: result.lines[0]?.after,
    });
  });

  it('refuses empty argv, forbidden paths and kill binaries through the shared exec guard', () => {
    const host = createMemoryHost();
    expect(isForbiddenExecArgv([])).toBe(true);
    expect(host.exec([])).toEqual({ code: 1, stdout: '', stderr: 'refused' });
    expect(host.exec(['cat', '/Users/alice/Library/Messages/chat.db'])).toEqual({ code: 1, stdout: '', stderr: 'refused' });
    expect(host.exec(['kill', '-9', '1234'])).toEqual({ code: 1, stdout: '', stderr: 'refused' });
    expect(isForbiddenExecArgv(['renice', '-n', '15', '-p', '90'])).toBe(false);
  });

  it('collects dispatchd ancestry, newest rollback mtime and sandbox profiles', () => {
    const now = new Date('2026-11-16T18:00:00.000Z');
    const host = createMemoryHost({ now });
    const agents = launchAgentsDir(host);
    const bin = join(host.runsDir(), 'bin');
    host.dirs.set(agents, [
      'ai.ashlr.example.plist',
      'ai.ashlr.example.plist.rollback.1',
      'ai.ashlr.example.plist.rollback.2',
    ]);
    host.mtimes.set(join(agents, 'ai.ashlr.example.plist'), now.getTime() - 60_000);
    host.mtimes.set(join(agents, 'ai.ashlr.example.plist.rollback.1'), now.getTime() - 30_000);
    host.mtimes.set(join(agents, 'ai.ashlr.example.plist.rollback.2'), now.getTime() - 10_000);
    host.dirs.set(bin, ['lane.sb', 'notes.txt']);
    host.files.set(join(bin, 'lane.sb'), '(version 1)\n');
    host.onExec = (argv) => {
      if (argv[0] === 'launchctl' && argv[1] === 'list') {
        return { code: 0, stdout: 'PID\tStatus\tLabel\n123\t0\tai.ashlr.example\n', stderr: '' };
      }
      if (argv[0] === 'ps') {
        return {
          code: 0,
          stdout: [
            '40 1 501 0 /usr/bin/dispatchd.py',
            '41 40 501 0 /usr/local/bin/node',
            '90 1 501 0 /usr/local/bin/node',
          ].join('\n'),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: '' };
    };
    const snapshot = collectSnapshot(host);
    expect(snapshot.launchdJobs).toEqual([expect.objectContaining({
      label: 'ai.ashlr.example',
      plistMtimeMs: now.getTime() - 60_000,
      rollbackMtimeMs: now.getTime() - 10_000,
    })]);
    expect(snapshot.processes.map((row) => [row.pid, row.dispatchdOwned])).toEqual([
      [40, true],
      [41, true],
      [90, false],
    ]);
    expect(snapshot.pinned.some((row) => row.name === 'lane.sb' && row.installedSha256 === sha256Hex('(version 1)\n'))).toBe(true);
    expect(snapshot.pinned.some((row) => row.name === 'notes.txt')).toBe(false);
  });

  it('dry-run does not kickstart or mark the incident fixed on disk', async () => {
    const host = createMemoryHost();
    host.dirs.set(incidentDir(host.runsDir()), ['INCIDENT-a_phantom_v3.30.35.md']);
    const lines: string[] = [];
    const code = await cmdAutofix(['--json', '--older-than', '30'], {
      host,
      snapshot: emptySnapshot(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as { schema: string; dryRun: boolean; incidents: { status: string }[] };
    expect(parsed.schema).toBe(AUTOFIX_SCHEMA);
    expect(parsed.dryRun).toBe(true);
    expect(host.calls.some((argv) => argv[1] === 'kickstart')).toBe(false);
    expect(host.files.has('/tmp/autofix-runs/ledger/incidents.jsonl')).toBe(false);

    const errors: string[] = [];
    expect(await cmdAutofix(['--older-than', '0'], { host, snapshot: emptySnapshot(), stderr: (line) => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain('--older-than');
  });
});
