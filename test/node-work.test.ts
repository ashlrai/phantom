/**
 * `phm node work --node <id> --session <n>` pulls the job the router assigned
 * the session and, for a `codex-file` job, runs the contract pack under the
 * job's lease: the node session and claim are renewed on a keepalive for the
 * run's duration, a fenced lease aborts the pack and hands the job back, and
 * completion carries the pack's result reference. Jobs the runner cannot
 * execute — another pack, secret names it cannot supply — are released with
 * --decline so the next pull takes the next routed job instead of spinning on
 * the same claim. Everything here is hermetic: MemoryStore, injected pack.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import type { CodexFileReply } from '../src/core/drive/nodes/codex-pack.js';
import { cmdNodeWork } from '../src/cli/node-work.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const task = (text: string) => ({ text, sha256: createHash('sha256').update(text).digest('hex') });

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(String(line)); });
  return lines;
}
afterEach(() => vi.restoreAllMocks());

/** A joined node plus optional queued jobs on one store. */
function fixture(opts: { ttls?: boolean } = {}) {
  const store = new MemoryStore();
  const drive = new DriveNodes(store, opts.ttls
    ? { nodeTtlMs: 120, leaderTtlMs: 200, claimTtlMs: 120 }
    : {});
  const joined = drive.join('laptop', { owners: ['acme'], caps: ['codex', 'build'] })!;
  return { store, drive, session: joined.session };
}

const workArgs = (session: number, extra: string[] = []) => ['--node', 'laptop', '--session', String(session), ...extra];
const lastJson = (lines: string[]) => JSON.parse(lines.at(-1)!);

describe('phm node work', () => {
  it('pulls a codex-file job, runs the pack and completes it with the result reference', async () => {
    const { store, drive, session } = fixture();
    drive.enqueue('review-1', { owner: 'acme', requires: ['codex'], pack: 'codex-file', task: task('Review the diff.') });
    const seen: { jobId: string; task: string; signaled: boolean }[] = [];
    const lines = capture();
    const code = await cmdNodeWork(workArgs(session, ['--json']), {
      drive, probeAuth: () => 'ok', keepaliveMs: 5,
      runPack: async (req, packDeps) => {
        seen.push({ jobId: req.jobId, task: req.task, signaled: packDeps?.signal !== undefined });
        return { resultRef: 'node-results:review-1', codex: 'ok' };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ jobId: 'review-1', task: 'Review the diff.', signaled: true }]);
    const out = lastJson(lines);
    expect(out).toMatchObject({ command: 'work', worked: true, jobId: 'review-1', resultRef: 'node-results:review-1', completed: true });
    const job = store.state.jobs.find(j => j.id === 'review-1')!;
    expect(job.state).toBe('completed');
    expect(job.result).toBe('node-results:review-1');
    expect(job.claim?.nodeId).toBe('laptop');
  });

  it('keeps the session and claim alive across a run longer than the lease TTLs', async () => {
    const { store, drive, session } = fixture({ ttls: true });
    drive.enqueue('slow-1', { owner: 'acme', requires: ['codex'], pack: 'codex-file', task: task('Slow work.') });
    capture();
    // 250 ms of pack time against 120 ms node/claim TTLs and a 200 ms leader
    // TTL: without the keepalive the claim and leader would both lapse and
    // completion would be refused.
    const code = await cmdNodeWork(workArgs(session, ['--json']), {
      drive, probeAuth: () => 'ok', keepaliveMs: 15,
      runPack: async () => { await sleep(250); return { resultRef: 'node-results:slow-1', codex: 'ok' }; },
    });
    expect(code).toBe(0);
    expect(store.state.jobs.find(j => j.id === 'slow-1')!.state).toBe('completed');
  });

  it('aborts the run and releases the claim plainly when the stop signal fires mid-pack', async () => {
    const { store, drive, session } = fixture();
    drive.enqueue('abort-1', { owner: 'acme', requires: ['codex'], pack: 'codex-file', task: task('Abort me.') });
    const ac = new AbortController();
    const lines = capture();
    const code = await cmdNodeWork(workArgs(session, ['--json']), {
      drive, probeAuth: () => 'ok', keepaliveMs: 5, signal: ac.signal,
      runPack: async (_req, packDeps) => {
        setTimeout(() => ac.abort(), 20);
        // Wait for the abort to reach the pack signal, then report the kill.
        for (let i = 0; i < 100 && !packDeps?.signal?.aborted; i++) await sleep(5);
        return { codex: 'error', packError: 'codex-timeout' };
      },
    });
    expect(code).toBe(1);
    expect(lastJson(lines)).toMatchObject({ worked: false, reason: 'lease-lost', jobId: 'abort-1' });
    const job = store.state.jobs.find(j => j.id === 'abort-1')!;
    expect(job.state).toBe('pending');
    expect(job.claim).toBeUndefined();
    expect(job.declined ?? []).not.toContain(session);
  });

  it('declines a non-codex-file job back to pending without running the pack', async () => {
    const { store, drive, session } = fixture();
    drive.enqueue('ping-1', { owner: 'acme', pack: 'shell-check' });
    let ran = false;
    const lines = capture();
    const code = await cmdNodeWork(workArgs(session, ['--json']), {
      drive, probeAuth: () => 'ok',
      runPack: async () => { ran = true; return { resultRef: 'x', codex: 'ok' }; },
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lastJson(lines)).toMatchObject({ worked: false, reason: 'unsupported-job', jobId: 'ping-1', pack: 'shell-check' });
    const job = store.state.jobs.find(j => j.id === 'ping-1')!;
    expect(job.state).toBe('pending');
    expect(job.declined).toContain(session);
  });

  it('declines a codex-file job that names secret NAMES the runner cannot supply', async () => {
    const { store, drive, session } = fixture();
    drive.enqueue('secret-1', { owner: 'acme', requires: ['codex'], pack: 'codex-file', secrets: ['DEPLOY_KEY'], task: task('Deploy.') });
    let ran = false;
    const lines = capture();
    const code = await cmdNodeWork(workArgs(session, ['--json']), {
      drive, probeAuth: () => 'ok',
      runPack: async () => { ran = true; return { resultRef: 'x', codex: 'ok' }; },
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(lastJson(lines)).toMatchObject({ worked: false, reason: 'needs-secrets', jobId: 'secret-1', secrets: ['DEPLOY_KEY'] });
    const job = store.state.jobs.find(j => j.id === 'secret-1')!;
    expect(job.state).toBe('pending');
    expect(job.declined).toContain(session);
  });

  it('releases plainly — not declined — when the pack itself fails', async () => {
    const { store, drive, session } = fixture();
    drive.enqueue('fail-1', { owner: 'acme', requires: ['codex'], pack: 'codex-file', task: task('Try me.') });
    const lines = capture();
    const code = await cmdNodeWork(workArgs(session, ['--json']), {
      drive, probeAuth: () => 'ok',
      runPack: async () => ({ codex: 'error', packError: 'binary-unavailable' }) as CodexFileReply,
    });
    expect(code).toBe(1);
    expect(lastJson(lines)).toMatchObject({ worked: false, reason: 'pack-error', jobId: 'fail-1', packError: 'binary-unavailable' });
    const job = store.state.jobs.find(j => j.id === 'fail-1')!;
    expect(job.state).toBe('pending');
    expect(job.declined ?? []).not.toContain(session);
  });

  it('answers the shared empty-pull message when nothing is routed', async () => {
    const { drive, session } = fixture();
    const lines = capture();
    const code = await cmdNodeWork(workArgs(session, ['--json']), { drive, probeAuth: () => 'ok' });
    expect(code).toBe(0);
    expect(lastJson(lines)).toMatchObject({ command: 'work', pulled: false });
  });

  it('answers session-expired for a dead session, like pull', async () => {
    const { drive } = fixture();
    const lines = capture();
    const code = await cmdNodeWork(workArgs(999, ['--json']), { drive, probeAuth: () => 'ok' });
    expect(code).toBe(1);
    expect(lastJson(lines).error.code).toBe('session-expired');
  });

  it('refuses on a pool-configured machine', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'node-work-pool-')));
    vi.stubEnv('ASHLR_HOME', home);
    try {
      mkdirSync(join(home, 'node-pool'), { recursive: true });
      writeFileSync(join(home, 'node-pool', 'config.json'), '{}');
      const lines = capture();
      const code = await cmdNodeWork(['--node', 'laptop', '--session', '1', '--json'], { probeAuth: () => 'ok' });
      expect(code).toBe(2);
      expect(lastJson(lines).error.message).toContain('node pool');
    } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses unknown flags and a missing --session as usage errors', async () => {
    const { drive } = fixture();
    const lines = capture();
    expect(await cmdNodeWork(['--node', 'laptop', '--bogus', '1', '--json'], { drive })).toBe(2);
    expect(lastJson(lines).error.code).toBe('usage');
    expect(await cmdNodeWork(['--node', 'laptop', '--session', 'x', '--json'], { drive })).toBe(2);
    expect(await cmdNodeWork(['--node', 'laptop', '--json'], { drive })).toBe(2);
  });
});
