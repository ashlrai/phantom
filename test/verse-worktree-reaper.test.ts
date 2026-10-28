import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionDeps, AgentEngine } from '../src/core/verse/agents/actions.js';
import type { AgentChecksRead } from '../src/core/verse/agents/checks.js';
import type { AgentStore } from '../src/core/verse/agents/store.js';
import { blankAgent } from '../src/core/verse/agents/store.js';
import { CHECKS_IDLE_MS, resetSupervisorCachesForTest, superviseAgent } from '../src/core/verse/agents/supervisor.js';
import type { AgentChecksDetail, AgentRecord, WorkspaceConfig } from '../src/core/verse/agents/types.js';
import { reapFinishedAgentWorktree } from '../src/core/verse/agents/worktree-reaper.js';
import type { VerseSession } from '../src/core/verse/types.js';

const mocks = vi.hoisted(() => ({ archive: vi.fn(), config: vi.fn() }));
vi.mock('../src/core/verse/agents/actions.js', async (original) => ({
  ...await original<typeof import('../src/core/verse/agents/actions.js')>(),
  archiveAgent: mocks.archive,
  refreshScripts: async (_deps: unknown, agent: AgentRecord) => ({ agent, ended: [] }),
}));
vi.mock('../src/core/verse/agents/workspace-config.js', async (original) => ({
  ...await original<typeof import('../src/core/verse/agents/workspace-config.js')>(),
  readWorkspaceConfig: mocks.config,
}));

const config: WorkspaceConfig = { setup: null, run: [], archive: null, copy: [], ports: 10 };
const evidence = (): Pick<AgentChecksDetail, 'pr' | 'branch' | 'unavailable'> => ({
  branch: 'verse/fix', unavailable: null,
  pr: { number: 963, title: 'Fix', url: 'https://github.com/ashlrai/phantom/pull/963', state: 'merged', mergeable: null, headSha: 'a'.repeat(40) },
});

function fixture() {
  let record: AgentRecord | null = {
    ...blankAgent({ id: 'ag_0123456789abcdef', title: 'Fix', at: '2026-10-26T00:00:00Z' }),
    autoMerge: true, sessionId: 'vs_1',
    workspace: { rootPath: '/repo', path: '/home/.ashlr-worktrees/repo/fix', branch: 'verse/fix', name: 'fix', portBase: 41000, portCount: 10, baseSha: 'a'.repeat(40) },
  };
  let session: Pick<VerseSession, 'status'> | null = { status: 'idle' };
  // Only methods exercised by the reaper and supervisor are provided; all state
  // stays in memory so no real worktree or user HOME can be touched.
  const store = {
    get: vi.fn(async () => record),
    update: vi.fn(async (_id: string, update: (a: AgentRecord) => AgentRecord) => {
      if (record) record = update(record);
      return record;
    }),
  } as unknown as AgentStore;
  const engine = { getSession: () => session } as AgentEngine;
  const deps: ActionDeps = { store, engine: () => engine, launcher: { start: vi.fn(), status: () => null, log: () => null, stop: vi.fn() }, priceOf: () => null };
  mocks.archive.mockImplementation(async (_deps: ActionDeps, agent: AgentRecord) => {
    record = { ...agent, archived: { at: '2026-10-26T00:00:00Z', reason: 'merged', ref: 'refs/ashlr/verse-archive/fix', sha: 'b'.repeat(40), headSha: 'a'.repeat(40), branchDeleted: true } };
    return record;
  });
  return { deps, get agent() { return record!; }, setAgent: (next: AgentRecord | null) => { record = next; }, setSession: (next: typeof session) => { session = next; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ config, source: 'default', warnings: [] });
  resetSupervisorCachesForTest();
});

describe('finished agent worktree reaper', () => {
  it('delegates to snapshot-preserving archive and is idempotent', async () => {
    const f = fixture();
    const result = await reapFinishedAgentWorktree(f.deps, f.agent, evidence());
    expect(mocks.archive).toHaveBeenCalledWith(f.deps, expect.objectContaining({ id: f.agent.id }), 'merged', config);
    expect(result.archived?.ref).toBe('refs/ashlr/verse-archive/fix');
    await reapFinishedAgentWorktree(f.deps, result, evidence());
    expect(mocks.archive).toHaveBeenCalledTimes(1);
  });

  it.each(['opt-out', 'pinned', 'pending', 'plan', 'script', 'running', 'error', 'missing-session', 'missing-engine', 'missing-record', 'missing-workspace', 'replaced'])('preserves %s agents', async (kind) => {
    const f = fixture();
    const observed = f.agent;
    if (kind === 'opt-out') f.setAgent({ ...f.agent, autoMerge: false });
    if (kind === 'pinned') f.setAgent({ ...f.agent, pinned: true });
    if (kind === 'pending') f.setAgent({ ...f.agent, pendingPrompt: 'More work' });
    if (kind === 'plan') f.setAgent({ ...f.agent, plan: { enabled: true, state: 'awaiting-approval', text: 'More work', turn: 2 } });
    if (kind === 'script') f.setAgent({ ...f.agent, scripts: [{ id: 'run', kind: 'run', name: 'Dev', via: 'process', tabId: null, state: 'running', exitCode: null, startedAt: '', endedAt: null }] });
    if (kind === 'running' || kind === 'error') f.setSession({ status: kind });
    if (kind === 'missing-session') f.setSession(null);
    if (kind === 'missing-engine') f.deps.engine = () => null;
    if (kind === 'missing-record') f.setAgent(null);
    if (kind === 'missing-workspace') f.setAgent({ ...f.agent, workspace: null });
    if (kind === 'replaced') f.setAgent({ ...f.agent, workspace: { ...f.agent.workspace!, rootPath: '/different-repo' } });
    await reapFinishedAgentWorktree(f.deps, observed, evidence());
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it.each(['open', 'closed', 'draft', 'unknown', 'wrong-branch', 'unavailable', 'missing-head'])('preserves %s evidence', async (kind) => {
    const f = fixture(); const check = evidence();
    if (kind === 'open' || kind === 'closed' || kind === 'draft') check.pr!.state = kind;
    if (kind === 'unknown') check.pr = null;
    if (kind === 'wrong-branch') check.branch = 'verse/other';
    if (kind === 'unavailable') check.unavailable = 'GitHub unavailable';
    if (kind === 'missing-head') check.pr!.headSha = null;
    await reapFinishedAgentWorktree(f.deps, f.agent, check);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it.each(['pinned', 'busy', 'replaced'])('rechecks %s state after config I/O', async (kind) => {
    const f = fixture();
    mocks.config.mockImplementation(async () => {
      if (kind === 'pinned') f.setAgent({ ...f.agent, pinned: true });
      if (kind === 'busy') f.setSession({ status: 'running' });
      if (kind === 'replaced') f.setAgent({ ...f.agent, workspace: { ...f.agent.workspace!, path: '/different' } });
      return { config };
    });
    await reapFinishedAgentWorktree(f.deps, f.agent, evidence());
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('propagates snapshot/archive failure without marking the agent archived', async () => {
    const f = fixture();
    mocks.archive.mockRejectedValueOnce(new Error('Snapshot could not be pinned'));
    await expect(reapFinishedAgentWorktree(f.deps, f.agent, evidence())).rejects.toThrow('Snapshot could not be pinned');
    expect(f.agent.archived).toBeNull();
    expect(f.deps.store.update).not.toHaveBeenCalled();
  });

  it('supervisor retries failed cleanup on a later merged-PR check without merging again', async () => {
    const f = fixture(); let now = 1_000_000;
    const detail: AgentChecksDetail = {
      ...evidence(), agentId: f.agent.id, sessionId: f.agent.sessionId, root: '/repo', base: 'main', dirty: 0, ahead: 0, behind: 0, diffstat: null,
      ci: 'passing', checks: [], comments: [], mergeVerdict: { allowed: false, reason: 'Already merged' }, autoFix: false, autoMerge: true, loopNote: null, checkedAt: '',
    };
    const read: AgentChecksRead = { detail, files: [], summary: { pr: detail.pr, ci: 'passing', dirty: 0, ahead: 0, comments: 0, checkedAt: null } };
    const merge = vi.fn();
    const killOn = vi.fn(async () => false);
    const pausedOn = vi.fn(async () => false);
    const deps = {
      store: () => f.deps.store, engine: f.deps.engine, launcher: () => f.deps.launcher, priceOf: f.deps.priceOf,
      readChecks: vi.fn(async () => read), merge, now: () => now,
      checksDeps: { killOn, pausedOn }, mutationFence: async (effect: () => Promise<string | null>) => effect(),
    };
    mocks.archive.mockRejectedValueOnce(new Error('Git could not remove workspace'));
    let result = await superviseAgent(deps, f.agent);
    expect(result.loopNote).toContain('archiving failed');
    expect(result.archived).toBeNull();
    now += CHECKS_IDLE_MS + 1;
    result = await superviseAgent(deps, result);
    expect(result.archived?.reason).toBe('merged');
    expect(result.loopNote).toContain('snapshot is kept');
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(merge).not.toHaveBeenCalled();

    for (const guard of [killOn, pausedOn]) {
      resetSupervisorCachesForTest();
      f.setAgent({ ...f.agent, archived: null });
      guard.mockResolvedValueOnce(true);
      const held = await superviseAgent(deps, f.agent);
      expect(held.archived).toBeNull();
      expect(held.loopNote).toContain('cleanup is holding');
      expect(mocks.archive).toHaveBeenCalledTimes(2);
    }
  });
});
