/**
 * RQ-PHX-RECUTCOREFLEETC397 recut check: the surviving unique work of PR #5211
 * (RQ-PHX-RECUTCOREOLDC190) on current master.
 *
 *   - scripts/bridge/update-behind.mjs exports updateBehind(), the per-PR
 *     supervisor hook that PUTs /update-branch for an authorized behind PR and
 *     hands a dirty one to the durable (prUrl, headSha) recut path;
 *   - `phm fleet queue stats` prints routerQueueStats() as JSON.
 *
 * Both are exercised here through injected dependencies only — no gh, no
 * network, no real home.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateBehind } from '../scripts/bridge/update-behind.mjs';
import { cmdRouterQueue } from '../src/cli/router-queue.js';
import { routerQueueRoot } from '../src/core/fleet/router-queue.js';

const REPO = 'ashlrai/phantom';
const HEAD = 'a'.repeat(40);
const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md'].map((name) => `ashlrai/${name}`);

const dirtyPr = {
  state: 'open', draft: false, auto_merge: { enabled_at: 'x' },
  base: { repo: { full_name: REPO }, ref: 'master' },
  head: { repo: { full_name: REPO }, ref: 'codex-bridge/RQ-TEST', sha: HEAD },
  mergeable: false, mergeable_state: 'dirty',
};

let home: string;
const originalHome = process.env['HOME'];
beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'recut-corefleet-c397-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('update-behind supervisor hook', () => {
  it('rejects malformed repo and PR arguments before any provider call', () => {
    const never = () => { throw new Error('must not call'); };
    expect(() => updateBehind('evil repo', 1, never)).toThrow();
    expect(() => updateBehind('otherorg/phantom', 1, never)).toThrow();
    expect(() => updateBehind(REPO, 0, never)).toThrow();
    expect(() => updateBehind(REPO, 'x', never)).toThrow();
  });

  it('skips PRs that are not authorized behind/dirty bridge PRs', () => {
    expect(updateBehind(REPO, 42, () => ({ ...dirtyPr, mergeable: null, mergeable_state: 'unknown' }))).toEqual({ status: 'skipped' });
    expect(updateBehind(REPO, 42, () => ({ ...dirtyPr, auto_merge: null }))).toEqual({ status: 'skipped' });
    expect(updateBehind(REPO, 42, () => ({ ...dirtyPr, head: { ...dirtyPr.head, ref: 'feature/x' } }))).toEqual({ status: 'skipped' });
    expect(updateBehind(REPO, 42, () => ({ ...dirtyPr, mergeable: true, mergeable_state: 'clean' }))).toEqual({ status: 'skipped' });
  });

  it('emits one deterministic recut ask keyed by (repo, number, headSha) for a dirty PR', () => {
    const first = updateBehind(REPO, 42, () => dirtyPr) as { status: string; headSha: string; ask: Record<string, unknown> };
    expect(first.status).toBe('recut-required');
    expect(first.headSha).toBe(HEAD);
    expect(first.ask['schema']).toBe('ask.v1');
    expect(first.ask['id']).toMatch(/^RQ-RECUT-[a-f0-9]{64}$/);
    expect(first.ask['repos']).toEqual([REPO]);
    expect(String(first.ask['task'])).toContain(`https://github.com/${REPO}/pull/42`);
    expect(String(first.ask['task'])).toContain(HEAD);
    const second = updateBehind(REPO, 42, () => dirtyPr) as { ask: { id: string } };
    expect(second.ask.id).toBe(first.ask['id']);
    const moved = updateBehind(REPO, 42, () => ({ ...dirtyPr, head: { ...dirtyPr.head, sha: 'b'.repeat(40) } })) as { ask: { id: string } };
    expect(moved.ask.id).not.toBe(first.ask['id']);
  });

  it('PUTs update-branch with expected_head_sha for an authorized behind PR', async () => {
    const calls: string[][] = [];
    const result = updateBehind(REPO, 42, (args: string[]) => {
      calls.push(args);
      if (args.some((arg) => arg.includes('update-branch'))) return {};
      return { ...dirtyPr, mergeable: true, mergeable_state: 'behind' };
    });
    expect(result).toEqual({ status: 'update-requested', headSha: HEAD });
    const put = calls.find((args) => args.some((arg) => arg.includes('update-branch')));
    expect(put).toBeDefined();
    expect(put).toContain('PUT');
    expect(put).toContain(`expected_head_sha=${HEAD}`);
  });
});

describe('phm fleet queue stats', () => {
  async function run(args: string[], input = '') {
    const output: unknown[] = [];
    const code = await cmdRouterQueue(args, { input: (async function* () { yield input; })(), output: (value) => output.push(value) });
    return { code, output };
  }

  beforeEach(() => {
    const root = routerQueueRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ v: 1, repositories: repos }), { mode: 0o600 });
  });

  it('reports empty queue totals as JSON', async () => {
    const stats = await run(['stats', '--json']);
    expect(stats.code).toBe(0);
    expect(stats.output[0]).toMatchObject({
      v: 1,
      totals: { outstanding: 0, done: 0, superseded: 0 },
      merge: { outstanding: 0, done: 0 },
      conflict: { outstanding: 0, done: 0 },
    });
    expect((stats.output[0] as { generatedAt: string }).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is listed in usage and rejects extra arguments', async () => {
    const help = await run(['help']);
    expect(help.code).toBe(0);
    expect(String((help.output[0] as { usage: string }).usage)).toContain('stats');
    expect((await run(['stats', 'extra'])).code).toBe(2);
    expect((await run(['stats', '--json', '--json'])).code).toBe(2);
  });
});
