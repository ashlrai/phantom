import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { parseNodeFleetFlags, runNodeFleet } from '../src/core/drive/nodes/commands.js';
import { NODE_TASK_LIMIT, nodeTaskArgs, validNodeTask, type EmbeddedNodeTask } from '../src/core/drive/nodes/task.js';
import { poolBridgeRouter, runNodeBridge, type NodeBridgeHost } from '../src/core/drive/nodes/ready-bridge.js';
import { emptyState, parseState } from '../src/core/drive/nodes/state.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const TEXT = 'Synthetic review prompt: list three harmless facts about rubber ducks. Ünïcode ok ✓';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const task = (text = TEXT): EmbeddedNodeTask => ({ text, sha256: sha(text) });
const READ = ['codex', 'pack:codex-file'];

function fixture(prompt: string | Buffer | null, opts: { link?: 'file' | 'outside' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-task-615s-')));
  roots.push(root);
  const host: NodeBridgeHost = { runsRoot: join(root, 'runs'), wtRoot: join(root, 'wt') };
  const prompts = join(host.runsRoot, 'queue', 'prompts');
  for (const d of ['queue/run', 'queue/batches', 'queue/prompts', 'bin']) mkdirSync(join(host.runsRoot, d), { recursive: true });
  copyFileSync(resolve('contrib/mac/dispatchd.py'), join(host.runsRoot, 'bin', 'dispatchd.py'));
  const job = 'RQ-REVIEW-TASK';
  let path = join(prompts, `${job}.md`);
  if (opts.link) {
    const target = join(opts.link === 'outside' ? root : prompts, 'target.md');
    writeFileSync(target, TEXT);
    symlinkSync(target, path);
  } else if (prompt !== null) writeFileSync(path, prompt);
  if (prompt === null && !opts.link) path = join(root, 'missing.md');
  writeFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), [job, 'phantom', 'codex-cmp', 'work', path].join('\t') + '\n');
  const now = 1_000_000;
  const nodes = new DriveNodes(new MemoryStore(), { now: () => now, nodeTtlMs: 600_000, leaderTtlMs: 600_000, claimTtlMs: 1_000 });
  const worker = nodes.join('fake-worker', { owners: ['ashlr'], caps: READ, slots: 1 })!;
  const stranger = nodes.join('fake-stranger', { owners: ['other'], caps: READ, slots: 1 })!;
  // The pool transport, but served in-process through the real flag parser and command runner.
  const calls: string[][] = [];
  const router = poolBridgeRouter((verb, args) => {
    calls.push([verb, ...args]);
    return { demoted: false, result: runNodeFleet(verb, parseNodeFleetFlags(verb, args), nodes, () => 'unknown') };
  }, root);
  const pass = () => runNodeBridge({ host, router, owner: 'ashlr', apply: true, now, pendingTtlMs: 60_000 });
  return { host, nodes, worker, stranger, pass, calls, job };
}

describe('embedded node task transport (#6822 slice)', () => {
  it('carries the exact prompt and digest from ready row to the owner-scoped pull, once', async () => {
    const f = fixture(TEXT);
    const report = await f.pass();
    expect(report.claimed).toEqual([f.job]);
    // The prompt file may now disappear: the receiving host never needs this host's prompt root.
    rmSync(join(f.host.runsRoot, 'queue', 'prompts'), { recursive: true });

    expect(f.nodes.pull(f.stranger)).toBeNull();
    const pulled = f.nodes.pull(f.worker)!;
    expect(pulled.job.task).toEqual({ text: TEXT, sha256: sha(TEXT) });
    expect(validNodeTask(pulled.job.task)).toBe(true);
    expect(pulled.job).toMatchObject({ id: `ready:${f.job}:1`, pack: 'codex-file', owner: 'ashlr', secrets: [] });
    expect(f.nodes.pull(f.worker)).toBeNull(); // no duplicate consumption of a running job

    // Operator/status views and the manifest never carry the text.
    const view = JSON.stringify(f.nodes.view(['ashlr']));
    expect(view).not.toContain('rubber');
    expect(JSON.stringify(f.nodes.view(['other']))).not.toContain(f.job);
    const manifests = join(f.host.runsRoot, 'queue', 'batches');
    const manifest = readFileSync(join(manifests, readdirNames(manifests)[0]!), 'utf8');
    expect(manifest).not.toContain('rubber');
    expect(JSON.parse(manifest)).toMatchObject({ taskSha256: sha(TEXT), routerScope: expect.any(String) });
    // The runner's existing request shape (worker passes the pulled job through unchanged) is accepted.
    expect(JSON.stringify(f.calls)).toContain('--task-part=');
  });

  it('serializes in bounded parts that reassemble through real flag parsing', () => {
    const long = 'é'.repeat(7000);
    const args = ['--job', 'j1', '--owner', 'ashlr', '--pack', 'codex-file', ...nodeTaskArgs(task(long))];
    expect(args.filter(a => a.startsWith('--task-part=')).every(a => a.length - 12 <= 4000)).toBe(true);
    const nodes = new DriveNodes(new MemoryStore());
    const flags = parseNodeFleetFlags('enqueue', args);
    expect(runNodeFleet('enqueue', flags, nodes, () => 'unknown'))
      .toMatchObject({ jobId: 'j1', enqueued: true, route: { nodeId: null } });
    // A part that looks like a flag is still data.
    const dashed = task('--task-part=still text');
    expect(runNodeFleet('enqueue', parseNodeFleetFlags('enqueue', ['--job', 'j2', '--owner', 'ashlr', '--pack', 'codex-file', ...nodeTaskArgs(dashed)]), nodes, () => 'unknown'))
      .toMatchObject({ jobId: 'j2', enqueued: true, route: { nodeId: null } });
  });

  it('rejects malformed digests, bad text and unsupported packs without echoing the text', () => {
    const nodes = new DriveNodes(new MemoryStore());
    const enqueue = (extra: string[]) => () => runNodeFleet('enqueue', parseNodeFleetFlags('enqueue', ['--job', 'bad', '--owner', 'ashlr', '--pack', 'codex-file', ...extra]), nodes, () => 'unknown');
    for (const extra of [
      ['--task-part=hello synthetic', '--task-sha256', 'sha256:xyz'],
      ['--task-part=hello synthetic', '--task-sha256', sha('hello synthetic')],
      ['--task-part=hello synthetic', '--task-sha256', `sha256:${sha('other')}`],
      ['--task-part=   ', '--task-sha256', `sha256:${sha('   ')}`],
      ['--task-part=hello synthetic'],
      ['--task-sha256', `sha256:${sha('x')}`],
    ]) expect(enqueue(extra), extra.join(' ')).toThrow(/Invalid embedded node task|is required/);
    expect(() => parseNodeFleetFlags('enqueue', ['--task-part', 'x'.repeat(4001)])).toThrow('Invalid embedded node task');
    expect(() => parseNodeFleetFlags('enqueue', Array.from({ length: 5 }, () => `--task-part=${'x'.repeat(4000)}`))).toThrow('Invalid embedded node task');
    // Secret-shaped text, lone surrogates and a non codex-file pack are refused by the validator and the store.
    expect(validNodeTask(task('token sk-ant-api03-' + 'a'.repeat(40)))).toBe(false);
    expect(validNodeTask({ text: '\ud800', sha256: sha('\ud800') })).toBe(false);
    expect(validNodeTask({ ...task(), extra: 1 })).toBe(false);
    expect(() => nodes.enqueue('p1', { owner: 'ashlr', pack: 'shell-check', task: task() })).toThrow('Invalid embedded node task');
    expect(() => nodes.enqueue('p2', { owner: 'ashlr', task: task() })).toThrow('Invalid embedded node task');
    expect(() => nodeTaskArgs({ text: 'a', sha256: 'bad' })).toThrow('Invalid embedded node task');
    expect(nodes.view(['ashlr']).jobs).toEqual([]);
    // A tampered store is rejected on load.
    const state = emptyState();
    state.jobs.push({ id: 'j', owner: 'ashlr', state: 'pending', pack: 'codex-file', task: { text: 'a', sha256: 'bad' } } as never);
    expect(() => parseState(JSON.parse(JSON.stringify(state)))).toThrow();
  });

  it.each([
    ['oversized', 'x'.repeat(NODE_TASK_LIMIT + 1), 'task_oversize'],
    ['empty', '   \n', 'task_invalid'],
    ['invalid UTF-8', Buffer.from([0x68, 0xff, 0xfe, 0x69]), 'task_invalid'],
    ['secret-shaped', 'key sk-ant-api03-' + 'a'.repeat(40), 'task_secret_shaped'],
  ])('keeps a %s prompt local with a reason code', async (_name, prompt, reason) => {
    const f = fixture(prompt);
    const report = await f.pass();
    expect(report.claimed).toEqual([]);
    expect(report.rows[0]).toMatchObject({ offload: false, nodeId: null, routerJobId: null });
    expect(report.rows[0]!.reasons).toContain(reason);
    expect(JSON.stringify(report)).not.toContain('sk-ant');
    expect(readFileSync(join(f.host.runsRoot, 'queue', 'ready.tsv'), 'utf8')).toContain(f.job);
    expect(f.nodes.view(['ashlr']).jobs).toEqual([]);
    expect(readdirNames(join(f.host.runsRoot, 'queue', 'batches'))).toEqual([]);
  });

  it.each([
    ['missing', null, undefined],
    ['symlinked prompt', TEXT, 'file' as const],
    ['symlink to outside the prompt root', TEXT, 'outside' as const],
  ])('refuses a %s prompt', async (_name, prompt, link) => {
    const f = fixture(prompt, link ? { link } : {});
    const report = await f.pass();
    expect(report.claimed).toEqual([]);
    expect(report.rows[0]!.reasons).toContain('task_unavailable');
    expect(f.nodes.pull(f.worker)).toBeNull();
  });

  it('refuses a prompt path outside the prompt root', async () => {
    const f = fixture(TEXT);
    const outside = join(f.host.runsRoot, 'outside.md');
    writeFileSync(outside, TEXT);
    writeFileSync(join(f.host.runsRoot, 'queue', 'ready.tsv'), [f.job, 'phantom', 'codex-cmp', 'work', outside].join('\t') + '\n');
    const report = await f.pass();
    expect(report.claimed).toEqual([]);
    expect(report.rows[0]!.reasons).toContain('task_unavailable');
  });

  it('is accepted by the standalone runner request shape (and a bad digest is not)', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'node-task-runner-')));
    roots.push(home);
    const run = (t: unknown) => {
      const input = JSON.stringify({ protocol: 'phm-node-worker/v1', job: { id: 'ready:RQ-REVIEW-TASK:1', pack: 'codex-file', secrets: [], task: t } });
      const r = spawnSync(process.execPath, [resolve('contrib/mac/node-runner.mjs'), 'run'], { input, encoding: 'utf8', timeout: 8000,
        env: { HOME: home, ASHLR_HOME: join(home, '.ashlr'), PATH: '/usr/bin:/bin' } });
      return JSON.parse(r.stdout) as { packError?: string };
    };
    expect(run({ text: TEXT, sha256: 'f'.repeat(64) }).packError).toBe('invalid-request');
    // Past request validation: the fake host has no codex, so it stops later with a different code.
    expect(run(task()).packError).not.toBe('invalid-request');
    expect(existsSync(join(home, 'node-tasks'))).toBe(false);
  });
});

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
