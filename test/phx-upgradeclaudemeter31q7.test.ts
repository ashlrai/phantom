import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/claude-window-upgrade-audit.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const roots: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'fake-upgrade-audit-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function invoke(args: string[], deps: Parameters<typeof run>[1] = {}) {
  let output = '';
  const code = await run(args, { ...deps, write: text => { output += text; } });
  return { code, output: JSON.parse(output) };
}
const args = (dir: string) => ['--scratch-dir', dir];

describe('offline Claude upgrade audit', () => {
  it('uses the real reader with a fake legacy fixture and isolated personal home', async () => {
    const dir = await scratch();
    const read = vi.fn<typeof readResourceLedger>(async opts => {
      expect(opts?.runsDir).toBe(await realpath(dir));
      expect(opts?.personalCodexHome).toBe(join(opts!.runsDir!, 'fake-personal-home'));
      const ledger = await readResourceLedger(opts);
      expect(ledger.sources.status).toBe('healthy');
      expect(ledger.lanes.find(row => row.lane === 'claude')).toMatchObject({ window: 'weekly', usedPct: null, resetAt: null, creditsRemaining: null });
      expect(JSON.stringify(ledger.lanes.find(row => row.lane === 'claude'))).not.toMatch(/five.?hour|5h/i);
      expect(ledger.lanes.find(row => row.lane === 'claude-api')).toMatchObject({ window: 'credits', creditsRemaining: 25 });
      expect(ledger.lanes.find(row => row.lane === 'codex-personal')).toMatchObject({ window: 'weekly', usedPct: 42 });
      return ledger;
    });
    expect(await invoke(args(dir), { read })).toEqual({ code: 0, output: { v: 1, result: 'verified', checks: { claude: true, apiCredits: true, codexWeekly: true } } });
    expect(read).toHaveBeenCalledOnce();
    const status = JSON.parse(await readFile(join(dir, 'queue/status.json'), 'utf8'));
    expect(status.budget.claude).toMatchObject({ five_hour_used_pct: 99, fiveHourPct: 98, messages_5h: 80, five_hour_reset_at: '2026-10-31T14:00:00Z' });
    expect(await readdir(join(dir, 'fake-personal-home'))).toEqual([]);
  });

  it.each(['missing', 'degraded'] as const)('reports %s status as insufficient evidence', async status => {
    const dir = await scratch();
    const result = await invoke(args(dir), { read: async opts => {
      const path = join(opts!.runsDir!, 'queue/status.json');
      if (status === 'missing') await rm(path);
      else await writeFile(path, '{bad fake status');
      return readResourceLedger(opts);
    } });
    expect(result).toEqual({ code: 3, output: { v: 1, result: 'inconclusive', reason: 'status_unavailable' } });
  });

  it('treats missing and duplicate lanes as insufficient evidence', async () => {
    for (const duplicate of [false, true]) {
      const dir = await scratch();
      expect(await invoke(args(dir), { read: async opts => {
        const ledger = await readResourceLedger(opts);
        if (duplicate) ledger.lanes.push(ledger.lanes[0]!);
        else ledger.lanes = ledger.lanes.filter(row => row.lane !== 'claude-api');
        return ledger;
      } })).toEqual({ code: 3, output: { v: 1, result: 'inconclusive', reason: 'missing_lane_evidence' } });
    }
  });

  it.each(['window', 'legacyField', 'reset', 'credits', 'codex'] as const)('detects a %s mismatch', async fault => {
    const dir = await scratch();
    const result = await invoke(args(dir), { read: async opts => {
      const ledger = await readResourceLedger(opts);
      const claude = ledger.lanes.find(row => row.lane === 'claude')!;
      if (fault === 'window') claude.window = 'five_hour' as typeof claude.window;
      if (fault === 'legacyField') Object.assign(claude, { fiveHourPct: 99 });
      if (fault === 'reset') claude.resetAt = '2026-10-31T14:00:00Z';
      if (fault === 'credits') ledger.lanes.find(row => row.lane === 'claude-api')!.creditsRemaining = null;
      if (fault === 'codex') ledger.lanes.find(row => row.lane === 'codex-personal')!.usedPct = null;
      return ledger;
    } });
    expect(result.code).toBe(1);
    expect(result.output.result).toBe('mismatch');
    expect(Object.values(result.output.checks)).toContain(false);
  });

  it('refuses invalid, relative, nonempty, symlink, and home scratch paths without reading', async () => {
    const dir = await scratch();
    const linkParent = await scratch();
    const link = join(linkParent, 'link');
    await symlink(dir, link);
    await writeFile(join(dir, 'keep'), 'fake');
    const read = vi.fn<typeof readResourceLedger>();
    for (const input of [[], ['--scratch-dir'], args(relative(process.cwd(), dir)), args(dir), args(link), args(homedir()), args(userInfo().homedir), ['--help', '--bad']]) {
      expect((await invoke(input, { read })).code).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['keep']);
    expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('fake');
  });

  it('provides side-effect-free help and static errors', async () => {
    const read = vi.fn<typeof readResourceLedger>();
    expect(await invoke(['--help'], { read })).toMatchObject({ code: 0, output: { v: 1, usage: expect.stringContaining('npx tsx') } });
    expect(read).not.toHaveBeenCalled();
    const dir = await scratch();
    expect(await invoke(args(dir), { read: async () => { throw new Error('private fake detail'); } })).toEqual({ code: 1, output: { v: 1, error: 'audit_failed' } });
  });

  it('runs as a guarded executable with a separate fake HOME', async () => {
    const dir = await scratch();
    const home = await scratch();
    await mkdir(join(home, 'marker'));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'examples/upgrade/claude-window-upgrade-audit.ts', ...args(dir)], {
      cwd: process.cwd(), env: { ...process.env, HOME: home },
    });
    expect(JSON.parse(stdout)).toMatchObject({ v: 1, result: 'verified' });
    expect(stderr).toBe('');
    expect(await readdir(home)).toEqual(['marker']);
  });
});
