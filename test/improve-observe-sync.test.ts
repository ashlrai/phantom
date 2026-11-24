import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import type { MirrorStatus } from '../src/core/fleet/mirrors.js';
import { appendLedger, readLedger, scoreOutcomes, type MetricSpec } from '../src/core/improve/outcomes.js';
import { syncImproveObservations } from '../src/core/improve/observe-sync.js';
import type { ObserveExec } from '../src/core/improve/observe.js';

const metric: MetricSpec = { name: 'gate-ms', direction: 'decrease', runner: { kind: 'npm', script: 'bench:gate' } };
const REPO = 'ashlrai/phantom';
let home: string, repo: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();

function register(id: string, pr: number, head: number) {
  appendLedger({ type: 'registered', proposalId: id, title: id, proposalKind: 'perf', source: { kind: 'deterministic', rule: 'test' }, metric, predictedDelta: null });
  appendLedger({ type: 'pr', proposalId: id, repository: REPO, number: pr });
  appendLedger({ type: 'measured', proposalId: id, phase: 'base', sha: 'a'.repeat(40), value: 100, reason: null });
  appendLedger({ type: 'measured', proposalId: id, phase: 'head', sha: 'b'.repeat(40), value: head, reason: null });
}

/** gh answers merges and the default branch; git fetch is stubbed, everything else is real. */
function execFor(mergeSha: () => string | null): ObserveExec {
  return (cmd, args, cwd) => {
    if (cmd === 'gh') {
      if (args[0] === 'repo') return 'main\n';
      if (args[0] === 'pr') {
        const sha = mergeSha();
        return JSON.stringify(sha === null ? { state: 'OPEN', mergeCommit: null } : { state: 'MERGED', mergeCommit: { oid: sha } });
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    }
    if (cmd === 'git' && args.includes('fetch')) return '';
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
  };
}

function mirror(over: Partial<MirrorStatus> = {}): MirrorStatus {
  return { nameWithOwner: REPO, path: repo, present: true, problem: null, state: null, ...over };
}

function taskStore(tasks: CloudTaskV1[]) {
  const store = new Map(tasks.map((t) => [t.id, t]));
  return {
    store,
    tasks: () => [...store.values()],
    readTask: (id: string) => store.get(id) ?? null,
    writeTask: (t: CloudTaskV1) => { store.set(t.id, t); },
  };
}

const mergedTask = (id: string, mergeSha: string, over: Record<string, unknown> = {}): CloudTaskV1 => ({
  id, repo: REPO, state: 'merged', pr: { number: 12 },
  outcome: { observedAt: '2026-10-17T00:00:00.000Z', headSha: 'e'.repeat(40), mergeSha, ci: 'success', failedChecks: [], reviewDecision: null, changesRequested: 0 },
  ...over,
}) as unknown as CloudTaskV1;

beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-observe-sync-')));
  process.env.HOME = home;
  repo = path.join(home, 'mirrors', 'ashlrai__phantom');
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  // The fleet mirror's origin is the GitHub repository by construction.
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('scheduled outcome observation', () => {
  it('records merges and reverts for registered proposals through the fleet mirror, idempotently', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'faster gate (#5)');
    const merge5 = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    register('1111111111', 5, 80);
    const store = taskStore([]);
    const deps = { mirrors: () => [mirror()], exec: execFor(() => merge5), tasks: store.tasks, readTask: store.readTask, writeTask: store.writeTask };

    const first = syncImproveObservations(deps);
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ intact: true, scanned: 1, appended: 1, cloudUpdated: 0, skipped: [] });
    expect(scoreOutcomes(readLedger().records)[0]).toMatchObject({ status: 'improved', merged: { sha: merge5 } });

    // Nothing new to record: the same pass appends nothing.
    expect(syncImproveObservations(deps).appended).toBe(0);

    git('revert', '--no-edit', merge5);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const revert = git('rev-parse', 'HEAD');
    const second = syncImproveObservations(deps);
    expect(second).toMatchObject({ appended: 1, errors: [] });
    expect(scoreOutcomes(readLedger().records)[0]).toMatchObject({ status: 'regressed', reverted: { sha: revert } });

    // A revert of the revert re-lands the change and restores the credit.
    git('revert', '--no-edit', revert);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const reland = git('rev-parse', 'HEAD');
    const third = syncImproveObservations(deps);
    expect(third).toMatchObject({ appended: 1, errors: [] });
    expect(scoreOutcomes(readLedger().records)[0]).toMatchObject({ status: 'improved', merged: { sha: reland }, reverted: null });
  });

  it('records merged cloud tasks\' revert state through the same pass', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'cloud change (#12)');
    const merge = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const store = taskStore([mergedTask('ct_a', merge)]);
    const deps = { mirrors: () => [mirror()], exec: execFor(() => null), tasks: store.tasks, readTask: store.readTask, writeTask: store.writeTask };

    // Nothing reverted yet: the pass scans but writes nothing.
    expect(syncImproveObservations(deps)).toMatchObject({ intact: true, scanned: 1, appended: 0, cloudUpdated: 0, errors: [] });

    git('revert', '--no-edit', merge);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const revert = git('rev-parse', 'HEAD');
    expect(syncImproveObservations(deps)).toMatchObject({ cloudUpdated: 1, errors: [] });
    expect(store.store.get('ct_a')?.outcome?.revertedBy).toBe(revert);
    // A second pass sees the recorded revert and finds no re-land: nothing rewrites.
    expect(syncImproveObservations(deps).cloudUpdated).toBe(0);

    git('revert', '--no-edit', revert);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(syncImproveObservations(deps)).toMatchObject({ cloudUpdated: 1 });
    expect(store.store.get('ct_a')?.outcome?.revertedBy).toBeNull();
  });

  it('keeps a repository without a usable mirror unknown instead of guessing', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'faster gate (#5)');
    const merge5 = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    register('1111111111', 5, 80);
    const store = taskStore([]);

    const noMirror = syncImproveObservations({ mirrors: () => [], exec: execFor(() => merge5), tasks: store.tasks, readTask: store.readTask, writeTask: store.writeTask });
    expect(noMirror).toMatchObject({ intact: true, scanned: 0, appended: 0, skipped: [{ repository: REPO, reason: 'no-mirror' }] });
    expect(scoreOutcomes(readLedger().records)[0]!.merged).toBeNull();

    const invalid = syncImproveObservations({ mirrors: () => [mirror({ present: false, problem: 'mirror path is a symlink' })], exec: execFor(() => merge5), tasks: store.tasks, readTask: store.readTask, writeTask: store.writeTask });
    expect(invalid.skipped).toEqual([{ repository: REPO, reason: 'mirror-invalid' }]);
    expect(invalid.errors[0]).toContain('fleet mirror unusable');
    expect(invalid.appended).toBe(0);
  });

  it('refuses a mirror whose origin is not the candidate repository', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'faster gate (#5)');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    register('1111111111', 5, 80);
    const store = taskStore([]);
    // Repoint origin at a different repository: every git fact would be about the wrong repo.
    git('remote', 'set-url', 'origin', 'https://github.com/ashlrai/locus.git');
    const res = syncImproveObservations({ mirrors: () => [mirror()], exec: execFor(() => null), tasks: store.tasks, readTask: store.readTask, writeTask: store.writeTask });
    expect(res).toMatchObject({ scanned: 0, appended: 0, skipped: [{ repository: REPO, reason: 'origin-mismatch' }] });
    expect(scoreOutcomes(readLedger().records)[0]!.merged).toBeNull();
  });

  it('reports a broken ledger and unavailable sources without writing', () => {
    register('1111111111', 5, 80);
    const broken = syncImproveObservations({ ledger: () => ({ records: [], intact: false, reasons: ['chain-broken-at-line-1'] }), mirrors: () => [mirror()] });
    expect(broken).toMatchObject({ intact: false, reasons: ['chain-broken-at-line-1'], appended: 0 });

    const unavailable = syncImproveObservations({ tasks: () => { throw new Error('store down'); }, mirrors: () => [mirror()] });
    expect(unavailable).toMatchObject({ intact: true, reason: 'source-unavailable', appended: 0 });
    expect(scoreOutcomes(readLedger().records)[0]!.merged).toBeNull();
  });
});
