import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildLanePrompt,
  checkLaneWorktree,
  evaluateDesktopLaneAdmission,
  measureDesktopHost,
  parseCodexWindowUsage,
  parseMemoryFreePercent,
  readCodexCmpUsage,
  runCodexDesktopLaneTask,
  type CodexLaneDeps,
  type DesktopHostSample,
  type GitProbes,
} from '../src/core/verse/codex-desktop-lane.js';
import type { DesktopAdapter, DesktopStatus, ToolCall } from '../src/core/verse/desktop-adapters.js';
import { formatAxNode } from '../src/core/verse/verse-mcp-computer.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const BUNDLE = 'com.openai.codex';
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const treeText = (nodes: Array<Record<string, unknown>>): string =>
  ['Accessibility tree of Codex', '<untrusted id="a" source="s">', ...nodes.map((n) => formatAxNode(n)), '</untrusted id="a">'].join('\n');

const healthy: DesktopHostSample = {
  load: { load1: 2, load5: 2, load15: 2, cores: 18, ratio: 0.1 },
  memoryFreePercent: 55,
};

function scratchDirs(): { home: string; worktree: string } {
  const home = mkdtempSync(join(tmpdir(), 'lane-home-'));
  const worktree = join(home, 'Projects', 'ashlrai', 'wt', 'job-one');
  mkdirSync(worktree, { recursive: true });
  return { home, worktree };
}

function fakeAdapter(statuses: DesktopStatus[], opts: { start?: () => Promise<{ ok: true; handle: string } | { ok: false; error: string }>; collect?: boolean } = {}): DesktopAdapter & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    id: 'codex',
    prompts,
    async start(task) {
      prompts.push(task);
      return opts.start ? opts.start() : { ok: true, handle: BUNDLE };
    },
    async status() {
      const s = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      return s;
    },
    async collect() {
      return opts.collect === false ? { ok: false, error: 'nothing readable' } : { ok: true, text: 'done: opened PR', truncated: false, untrusted: true };
    },
  };
}

const gitOk = (overrides: Partial<GitProbes> = {}): GitProbes => ({
  branch: async () => 'feat/lane-one',
  dirtyCount: async () => 0,
  prUrl: async () => 'https://github.com/ashlrai/phantom/pull/9999',
  ...overrides,
});

const fastSmoke = { pollMs: 1, timeoutMs: 10_000, sleep: async () => undefined, now: () => 0 };

function laneDeps(over: Partial<CodexLaneDeps> & { home: string; adapter: DesktopAdapter }): CodexLaneDeps {
  return { bundle: BUNDLE, host: async () => healthy, git: gitOk(), smoke: fastSmoke, ...over };
}

describe('admission', () => {
  it('admits a healthy host', () => {
    expect(evaluateDesktopLaneAdmission(healthy)).toEqual({ admit: true });
  });
  it('refuses load at or above the ratio limit', () => {
    const busy: DesktopHostSample = { load: { load1: 30, load5: 30, load15: 30, cores: 18, ratio: 1.7 }, memoryFreePercent: 55 };
    expect(evaluateDesktopLaneAdmission(busy)).toMatchObject({ admit: false, reason: expect.stringContaining('load') });
  });
  it('refuses low memory free percentage', () => {
    expect(evaluateDesktopLaneAdmission({ ...healthy, memoryFreePercent: 10 })).toMatchObject({ admit: false, reason: expect.stringContaining('memory') });
  });
  it('fails closed when load or memory is unknown', () => {
    expect(evaluateDesktopLaneAdmission({ load: { load1: null, load5: null, load15: null, cores: null, ratio: null }, memoryFreePercent: 55 }).admit).toBe(false);
    expect(evaluateDesktopLaneAdmission({ ...healthy, memoryFreePercent: null }).admit).toBe(false);
  });
  it('parses memory_pressure output and rejects nonsense', () => {
    expect(parseMemoryFreePercent('The system has...\nSystem-wide memory free percentage: 55%\n')).toBe(55);
    expect(parseMemoryFreePercent('System-wide memory free percentage: 140%')).toBeNull();
    expect(parseMemoryFreePercent(null)).toBeNull();
  });
  it('measures the host with injected probes and tolerates a failed memory command', async () => {
    const sample = await measureDesktopHost({
      loadavg: () => [3, 2, 1],
      cpus: () => new Array(10).fill({}),
      command: async () => null,
    });
    expect(sample.load).toMatchObject({ load1: 3, cores: 10, ratio: 0.3 });
    expect(sample.memoryFreePercent).toBeNull();
  });
});

describe('worktree boundary', () => {
  const home = '/Users/test';
  it('refuses relative paths and control characters', () => {
    expect(checkLaneWorktree('relative/wt', home).ok).toBe(false);
    expect(checkLaneWorktree('/Users/test/x\ny', home).ok).toBe(false);
  });
  it('refuses any path inside the Codex credential directory or Phantom state', () => {
    for (const p of ['/Users/test/.codex', '/Users/test/.codex/sessions', '/Users/test/.codex-personal/wt', '/Users/test/.ashlr', '/Users/test/.ashlr-runs/handoff']) {
      expect(checkLaneWorktree(p, home)).toMatchObject({ ok: false });
    }
  });
  it('refuses a missing path and a file', () => {
    const { home: realHome } = scratchDirs();
    expect(checkLaneWorktree(join(realHome, 'nope'), realHome)).toMatchObject({ ok: false, error: 'worktree does not exist' });
  });
  it('accepts an existing directory outside the protected roots', () => {
    const { home: realHome, worktree } = scratchDirs();
    expect(checkLaneWorktree(worktree, realHome)).toEqual({ ok: true, path: worktree });
  });
  it('puts the boundary in the prompt ahead of the task', () => {
    const prompt = buildLanePrompt('/wt/one', '  fix the flaky test  ');
    expect(prompt.startsWith('Work only inside this git worktree: /wt/one')).toBe(true);
    expect(prompt.endsWith('fix the flaky test')).toBe(true);
  });
});

describe('runCodexDesktopLaneTask', () => {
  it('submits the task, waits for idle, and reports branch, dirty count and PR', async () => {
    const { home, worktree } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'working', signals: [] }, { state: 'idle', signals: [] }]);
    const res = await runCodexDesktopLaneTask({ id: 'job-1', task: 'Add the lane test', worktree }, laneDeps({ home, adapter }));
    expect(res).toMatchObject({ ok: true, jobId: 'job-1', branch: 'feat/lane-one', dirtyFiles: 0, prUrl: 'https://github.com/ashlrai/phantom/pull/9999' });
    expect(adapter.prompts[0]).toContain(worktree);
    expect(adapter.prompts[0]).toContain('Add the lane test');
  });

  it('refuses before touching the app when admission fails', async () => {
    const { home, worktree } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'idle', signals: [] }]);
    const res = await runCodexDesktopLaneTask({ id: 'job-2', task: 'x', worktree }, laneDeps({ home, adapter, host: async () => ({ ...healthy, memoryFreePercent: 2 }) }));
    expect(res).toMatchObject({ ok: false, stage: 'admission' });
    expect(adapter.prompts).toHaveLength(0);
  });

  it('refuses a protected worktree before admission', async () => {
    const { home } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'idle', signals: [] }]);
    const res = await runCodexDesktopLaneTask({ id: 'job-3', task: 'x', worktree: join(home, '.codex') }, laneDeps({ home, adapter }));
    expect(res).toMatchObject({ ok: false, stage: 'worktree' });
    expect(adapter.prompts).toHaveLength(0);
  });

  it('refuses a job id or task that would not fit the desktop task contract', async () => {
    const { home, worktree } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'idle', signals: [] }]);
    expect(await runCodexDesktopLaneTask({ id: 'bad id!', task: 'x', worktree }, laneDeps({ home, adapter }))).toMatchObject({ ok: false, stage: 'job' });
    expect(await runCodexDesktopLaneTask({ id: 'job-4', task: '   ', worktree }, laneDeps({ home, adapter }))).toMatchObject({ ok: false, stage: 'job' });
    expect(await runCodexDesktopLaneTask({ id: 'job-5', task: 'x'.repeat(2000), worktree }, laneDeps({ home, adapter }))).toMatchObject({ ok: false, stage: 'job' });
    expect(adapter.prompts).toHaveLength(0);
  });

  it('stops at needs-input and reports the status stage', async () => {
    const { home, worktree } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'needs-input', signals: ['approval-control'] }]);
    const res = await runCodexDesktopLaneTask({ id: 'job-6', task: 'x', worktree }, laneDeps({ home, adapter }));
    expect(res).toMatchObject({ ok: false, stage: 'status' });
  });

  it('reports a detached HEAD as a git-stage failure', async () => {
    const { home, worktree } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'idle', signals: [] }]);
    const res = await runCodexDesktopLaneTask({ id: 'job-7', task: 'x', worktree }, laneDeps({ home, adapter, git: gitOk({ branch: async () => null }) }));
    expect(res).toMatchObject({ ok: false, stage: 'git' });
  });

  it('reports no PR as a null prUrl, not a failure', async () => {
    const { home, worktree } = scratchDirs();
    const adapter = fakeAdapter([{ state: 'idle', signals: [] }]);
    const res = await runCodexDesktopLaneTask({ id: 'job-8', task: 'x', worktree }, laneDeps({ home, adapter, git: gitOk({ prUrl: async () => null }) }));
    expect(res).toMatchObject({ ok: true, prUrl: null });
  });

  it('allows one task per app at a time and releases the slot after a failure', async () => {
    const { home, worktree } = scratchDirs();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = fakeAdapter([{ state: 'idle', signals: [] }], {
      start: async () => { await gate; return { ok: true, handle: BUNDLE }; },
    });
    const first = runCodexDesktopLaneTask({ id: 'job-9', task: 'x', worktree }, laneDeps({ home, adapter: slow }));
    await new Promise((r) => setTimeout(r, 5));
    const second = await runCodexDesktopLaneTask({ id: 'job-10', task: 'x', worktree }, laneDeps({ home, adapter: fakeAdapter([]) }));
    expect(second).toMatchObject({ ok: false, stage: 'busy' });
    release();
    expect(await first).toMatchObject({ ok: true });
    const failed = fakeAdapter([{ state: 'idle', signals: [] }], { start: async () => ({ ok: false, error: 'no composer' }) });
    expect(await runCodexDesktopLaneTask({ id: 'job-11', task: 'x', worktree }, laneDeps({ home, adapter: failed }))).toMatchObject({ ok: false, stage: 'start' });
    expect(await runCodexDesktopLaneTask({ id: 'job-12', task: 'x', worktree }, laneDeps({ home, adapter: fakeAdapter([{ state: 'idle', signals: [] }]) }))).toMatchObject({ ok: true });
  });
});

describe('CMP usage from the visible window', () => {
  it('reads used percentage and an absolute reset date', () => {
    expect(parseCodexWindowUsage(['Weekly usage', '62% used', 'Resets Nov 25'], NOW)).toEqual({ pctUsed: 62, resetAt: '2026-11-25T00:00:00.000Z' });
  });
  it('converts remaining to used', () => {
    expect(parseCodexWindowUsage(['38% remaining', 'resets Nov 25, 2026'], NOW)?.pctUsed).toBe(62);
  });
  it('reads a relative reset', () => {
    expect(parseCodexWindowUsage(['40% used', 'Resets in 2d 3h'], NOW)).toEqual({ pctUsed: 40, resetAt: '2026-11-18T15:00:00.000Z' });
  });
  it('is unknown without a percentage, a parseable reset, or with an impossible value', () => {
    expect(parseCodexWindowUsage(['Resets Nov 25'], NOW)).toBeNull();
    expect(parseCodexWindowUsage(['62% used'], NOW)).toBeNull();
    expect(parseCodexWindowUsage(['140% used', 'Resets Nov 25'], NOW)).toBeNull();
    expect(parseCodexWindowUsage(['62% used', 'Resets Smarch 32'], NOW)).toBeNull();
  });
  it('returns a usage-signal reading from the window tree and never a guess', async () => {
    const tree: ToolCall = async (name) => name === 'computer_ax_tree'
      ? ok(treeText([{ ref: 'e1', role: 'AXStaticText', title: 'Usage', value: '62% used · Resets Nov 25', depth: 1 }]))
      : err('unexpected');
    expect(await readCodexCmpUsage(tree, { now: NOW })).toEqual({
      pool: 'codex-cmp', pctUsed: 62, resetAt: '2026-11-25T00:00:00.000Z', source: 'codex-desktop-window', fetchedAt: NOW.toISOString(),
    });
  });
  it('returns null when the tree is unreadable or shows no usage', async () => {
    expect(await readCodexCmpUsage(async () => err('no desktop access'), { now: NOW })).toBeNull();
    const empty: ToolCall = async () => ok(treeText([{ ref: 'e1', role: 'AXStaticText', title: 'Hello', depth: 1 }]));
    expect(await readCodexCmpUsage(empty, { now: NOW })).toBeNull();
  });
});
