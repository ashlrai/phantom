/**
 * Fleet worktree custody, step 1 (design-custody-fleet.md 3.3 and decision 1):
 * every spawn that is NOT wrapped by `phantom exec` leaves one durable,
 * value-free record in ~/.ashlr/custody/spawns.jsonl, visible in `phm status`
 * (text and JSON) and in the Shadow Report. `.phantom.toml` is never copied
 * into sandbox worktrees (it would select a different, empty vault namespace).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';

const installed = vi.hoisted(() => ({ value: true }));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: unknown[]) => {
      if (args[0] === 'which' || args[0] === 'where') {
        if (!installed.value) throw new Error('not found');
        return Buffer.from('/usr/local/bin/phantom');
      }
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
    }),
  };
});

function cfg(enabled: boolean): AshlrConfig {
  return {
    version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {}, tools: {}, phantom: { enabled },
  } as unknown as AshlrConfig;
}

let home: string; let dir: string;
const origHome = process.env.HOME; const origProfile = process.env.USERPROFILE;
const origPreflight = process.env.ASHLR_PHANTOM_PREFLIGHT;
beforeEach(() => {
  vi.resetModules();
  installed.value = true;
  home = mkdtempSync(join(tmpdir(), 'custody-fleet-home-'));
  dir = mkdtempSync(join(tmpdir(), 'custody-fleet-wt-'));
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.ASHLR_PHANTOM_PREFLIGHT;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  process.env.HOME = origHome; if (origProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origProfile;
  if (origPreflight === undefined) delete process.env.ASHLR_PHANTOM_PREFLIGHT; else process.env.ASHLR_PHANTOM_PREFLIGHT = origPreflight;
});

async function spawnOnce(enabled: boolean, bin = 'nonexistent-engine-custody-fleet', extra: Record<string, unknown> = {}): Promise<void> {
  const { spawnEngine } = await import('../src/core/run/engines.js');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const cmd: EngineCommand = { bin, args: [], cwd: dir };
  await spawnEngine(cmd, cfg(enabled), { timeoutMs: 5_000, ...extra });
}
function ledgerLines(): Array<Record<string, unknown>> {
  const p = join(home, '.ashlr', 'custody', 'spawns.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('unwrapped spawn records in the custody ledger', () => {
  it('phantom-disabled: recorded durably even with phantom off', async () => {
    await spawnOnce(false);
    expect(ledgerLines()).toEqual([expect.objectContaining({ schema: 1, wrapped: false, reason: 'phantom-disabled', engine: 'nonexistent-engine-custody-fleet', preflight_exit: null })]);
  });

  it('phantom-not-installed', async () => {
    installed.value = false;
    await spawnOnce(true);
    expect(ledgerLines()[0]).toMatchObject({ wrapped: false, reason: 'phantom-not-installed' });
  });

  it('not-initialized: no .phantom.toml in the worktree', async () => {
    await spawnOnce(true);
    expect(ledgerLines()[0]).toMatchObject({ wrapped: false, reason: 'not-initialized' });
  });

  it('self-authenticating-engine: claude without .phantom.toml', async () => {
    await spawnOnce(true, 'claude-not-really');
    await spawnOnce(true, join(dir, 'claude'));
    expect(ledgerLines().map((l) => l['reason'])).toEqual(['not-initialized', 'self-authenticating-engine']);
  });

  it('worktree-namespace: linked git worktree with .phantom.toml', async () => {
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/.git/worktrees/x\n');
    await spawnOnce(true);
    expect(ledgerLines()[0]).toMatchObject({ wrapped: false, reason: 'worktree-namespace' });
  });

  it('preflight-blocked and preflight-unavailable (opt-in strict preflight)', async () => {
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    mkdirSync(join(dir, '.git'));
    process.env.ASHLR_PHANTOM_PREFLIGHT = '1';
    await spawnOnce(true, 'nonexistent-engine-custody-fleet', { preflightRunner: () => ({ status: 1, stdout: JSON.stringify({ schema_version: 1, kind: 'phantom.agent.preflight', verdict: 'blocked', readiness: 'unsafe', risk_level: 'critical', vault_probed: false, checks: [{ id: 'invalid-config', severity: 'critical', requires_approval: false }], wrap: { exec_ready: false, blocked_by: ['invalid-config'] } }) }) });
    await spawnOnce(true, 'nonexistent-engine-custody-fleet', { preflightRunner: () => { throw new Error('no phantom'); } });
    expect(ledgerLines().map((l) => [l['wrapped'], l['reason']])).toEqual([[false, 'preflight-blocked'], [false, 'preflight-unavailable']]);
  });

  it('a wrapped spawn writes a wrapped record and no unwrapped record', async () => {
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    mkdirSync(join(dir, '.git'));
    await spawnOnce(true);
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ wrapped: true });
    expect(lines[0]).not.toHaveProperty('reason');
  });

  it('records no paths, env values or secrets (runtime fake keys)', async () => {
    const fake = `sk_${randomBytes(20).toString('hex')}`;
    process.env['ASHLR_FAKE_CUSTODY_KEY'] = fake;
    try {
      writeFileSync(join(dir, '.phantom.toml'), `[phantom]\nproject_id = "${fake}"\n`);
      writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${fake}\n`);
      writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/.git/worktrees/x\n');
      await spawnOnce(true, join(dir, `engine-${fake.slice(3, 9)}`));
      await spawnOnce(false, `/bad path ${fake}/bad engine`);
      const text = readFileSync(join(home, '.ashlr', 'custody', 'spawns.jsonl'), 'utf8');
      for (const v of [fake, fake.slice(3), dir, home, '/bad path']) expect(text).not.toContain(v);
      expect(ledgerLines().map((l) => l['engine'])).toEqual([`engine-${fake.slice(3, 9)}`, 'unknown']);
    } finally { delete process.env['ASHLR_FAKE_CUSTODY_KEY']; }
  });

  it('a ledger write failure is swallowed and the spawn still runs', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'custody'), 'not a directory');
    const { spawnEngine } = await import('../src/core/run/engines.js');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const seen: unknown[] = [];
    await expect(spawnEngine({ bin: 'nonexistent-engine-custody-fleet', args: [], cwd: dir }, cfg(false), { timeoutMs: 5_000, onCustody: (r) => seen.push(r) })).resolves.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(readFileSync(join(home, '.ashlr', 'custody'), 'utf8')).toBe('not a directory');
  });
});

describe('custody records surface in status and the Shadow Report', () => {
  it('status text and JSON break unwrapped spawns down by reason code', async () => {
    await spawnOnce(false);
    await spawnOnce(true);
    await spawnOnce(true);
    const { gatherCustodyStatus, formatCustodyStatusLine } = await import('../src/cli/status-custody.js');
    const s = gatherCustodyStatus()!;
    expect(s.spawns).toMatchObject({ total: 3, wrapped: 0, unwrapped: 3, unwrappedByReason: { 'phantom-disabled': 1, 'not-initialized': 2 } });
    expect(formatCustodyStatusLine(s)).toContain('spawns 3 in 24h: 0 wrapped, 3 unwrapped (not-initialized 2, phantom-disabled 1)');
    const json = JSON.stringify(s);
    expect(JSON.parse(json).spawns.unwrappedByReason).toEqual({ 'not-initialized': 2, 'phantom-disabled': 1 });
    expect(json).not.toContain(dir);
  });

  it('the Shadow Report custody section lists the reason codes', async () => {
    await spawnOnce(true);
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/.git/worktrees/x\n');
    await spawnOnce(true);
    const { readCustodySummary } = await import('../src/core/run/custody-ledger.js');
    const { buildCanaryShadowReport, formatCanaryShadowReport } = await import('../src/core/fleet/automerge-canary-shadow-report.js');
    const report = buildCanaryShadowReport({ enforceSupported: false, sourceState: 'missing', severity: 'none', status: 'inactive', active: false, state: null, revisions: [], terminalEpochs: [], diagnostics: [], limitExceeded: false } as never, readCustodySummary(null));
    const text = formatCanaryShadowReport(report, false);
    expect(text).toMatch(/custody: spawns 2, wrapped 0, unwrapped 2 \(.*not-initialized 1.*worktree-namespace 1.*\)/);
    expect(JSON.parse(formatCanaryShadowReport(report, true)).custody.unwrapped).toEqual({ 'not-initialized': 1, 'worktree-namespace': 1 });
  });
});
