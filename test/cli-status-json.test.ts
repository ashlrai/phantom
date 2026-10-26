/**
 * CLI contract: `phm status --json` prints exactly one JSON object on stdout,
 * with no ANSI color codes and no human prose. Runs the source CLI in a fresh
 * Node/tsx subprocess against a temp HOME so it never reads the real ~/.ashlr.
 * PATH is narrowed to the Node binary's directory so the best-effort
 * gh / vercel / phantom reads degrade to null instead of touching the network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { banditStatus, recordProposalBanditOutcome, reconcileBanditOutcomes } from '../src/core/fleet/bandit-feedback.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import { checkBandit } from '../src/core/doctor.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runStatus(args: string[], writeConfig: (home: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-status-json-')); homes.push(home);
  writeConfig(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath) };
  delete env.ASHLR_HOME;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'status', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env,
  });
  return { home, result };
}

describe('CLI: phm status --json', () => {
  it('prints one parseable JSON object with no ANSI codes', () => {
    const { result } = runStatus(['--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    const data = JSON.parse(result.stdout) as Record<string, unknown> & {
      summary: Record<string, number>; roots: Array<{ path: string; exists: boolean }>;
    };
    expect(data.schemaVersion).toBe(1);
    expect(data.summary).toEqual({ tracked: 0, clean: 0, dirty: 0, offSync: 0, stale: 0, staleDays: 30 });
    expect(data.dirty).toEqual([]);
    // A fresh HOME with no code folders gets no roots (not two missing ones).
    expect(data.roots).toEqual([]);
    for (const key of ['tools', 'mcpServers', 'activity7d', 'memory', 'github', 'vercel', 'identity', 'resources', 'custody', 'localInference', 'phantomPreflight']) {
      expect(data).toHaveProperty(key);
    }
  });

  it('shows bandit arm statistics and the current readiness reason', () => {
    const { result } = runStatus(['--json'], home => {
      const dir = join(home, '.ashlr', 'routing');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({
        localFirstBandit: { enabled: true, minSamplesPerArm: 1 },
      }));
      writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ schemaVersion: 1, entries: [
        { itemId: 'local-item', engineClass: 'local' },
        { itemId: 'frontier-item', engineClass: 'frontier' },
      ] }));
      writeFileSync(join(dir, 'merge-outcomes.json'), JSON.stringify({ schemaVersion: 1, outcomes: [
        { itemId: 'local-item', merged: true, costUsd: 0, wallMs: 3_600_000 },
        { itemId: 'frontier-item', merged: false, costUsd: 2, wallMs: 7_200_000 },
      ] }));
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).bandit).toEqual({ enabled: true, reason: 'ready', stats: {
      local: { pulls: 1, merges: 1, costUsd: 0, hours: 1 },
      frontier: { pulls: 1, merges: 0, costUsd: 2, hours: 2 },
    } });
  });

  it('detects an existing code folder as a root when no config exists', () => {
    const { home, result } = runStatus(['--json'], (h) => mkdirSync(join(h, 'code'), { recursive: true }));
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as { roots: Array<{ path: string; exists: boolean }> };
    expect(data.roots).toEqual([{ path: join(home, 'code'), exists: true }]);
  });

  it('reports configured roots and whether each exists', () => {
    const { result } = runStatus(['--json'], (home) => {
      const code = join(home, 'code');
      mkdirSync(code, { recursive: true });
      mkdirSync(join(home, '.ashlr'), { recursive: true });
      writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({
        version: 1, roots: [code, join(home, 'missing')], staleDays: 7,
      }));
    });
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as { summary: { staleDays: number }; roots: Array<{ exists: boolean }> };
    expect(data.summary.staleDays).toBe(7);
    expect(data.roots.map(r => r.exists)).toEqual([true, false]);
  });

  it('keeps the human board without --json', () => {
    const { result } = runStatus([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ashlr status');
    expect(result.stdout).toContain('No git repos are being tracked yet.');
    expect(result.stdout).toContain('phm config set roots --json');
    // Only this platform's quoting is shown.
    if (process.platform !== 'win32') expect(result.stdout).not.toContain('PowerShell');
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

const start = '2026-10-26T12:00:00Z';
const end = Date.parse(start) + 3_600_000;
const secret = 'sk-test-only-sensitive-value-12345678901234567890';
const cfg = { localFirstBandit: { enabled: true, minSamplesPerArm: 1 } } as unknown as AshlrConfig;

const routingLedgerPath = () => join(homedir(), '.ashlr', 'routing', 'last-run.json');
const mergeOutcomesPath = () => join(homedir(), '.ashlr', 'routing', 'merge-outcomes.json');
function readMergeOutcomes(): Array<{ itemId: string; merged: boolean; costUsd?: number; wallMs?: number }> {
  return existsSync(mergeOutcomesPath()) ? JSON.parse(readFileSync(mergeOutcomesPath(), 'utf8')).outcomes : [];
}

function fixture(state: 'open' | 'merged' | 'closed' = 'open', engineClass: 'local' | 'frontier' | 'unclassified' = 'local'): Proposal {
  const proposal = createProposal({ repo: null, origin: 'backlog', kind: 'patch', title: 'fixture',
    summary: secret, workItemId: 'repo:task:fixture', runId: 'fixture-run' });
  // Serialized production store fixtures keep this test focused on accounting.
  const merge = { v: 1, key: proposal.id, kind: 'change', proposalId: proposal.id,
    revertsLandingId: null, repo: 'example/repo', repoPath: '/tmp/fixture', enforcement: null,
    createdAt: start, updatedAt: new Date(end).toISOString(), judgeWaitSince: null,
    gates: {}, merge: null, landing: null, outcome: null,
    pr: { number: 1, nodeId: 'PR_fixture', repositoryId: 'R_fixture', branch: 'fleet/fixture', baseBranch: 'master',
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), ownerLane: false, ownerLaneReason: null,
    openedAt: start, ledgered: true, state, closedBy: null, nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null } };
  const states = join(homedir(), '.ashlr', 'authority', 'fleet-merge');
  mkdirSync(states, { recursive: true, mode: 0o700 });
  writeFileSync(join(states, `${proposal.id}.json`), JSON.stringify(merge), { mode: 0o600 });
  mkdirSync(join(homedir(), '.ashlr', 'routing'), { recursive: true });
  writeFileSync(routingLedgerPath(), JSON.stringify({ schemaVersion: 1, entries: [{ at: start, itemId: proposal.workItemId!,
    seatId: 'local', engine: 'local', engineClass, lane: 'local', reason: 'local-ok' }] }));
  mkdirSync(join(homedir(), '.ashlr', 'runs'), { recursive: true });
  writeFileSync(join(homedir(), '.ashlr', 'runs', 'fixture-run.json'), JSON.stringify({ id: 'fixture-run', tasks: [],
    usage: { estCostUsd: 0.75 }, goal: secret, result: secret }));
  return proposal;
}

describe('fleet bandit completion feedback', () => {
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(end);
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  mkdirSync(join(homedir(), '.ashlr'), { recursive: true });
  writeFileSync(join(homedir(), '.ashlr', 'config.json'), JSON.stringify(cfg));
});

  it('records the merge-pass lifecycle hook with the routing item id and run cost, without content', () => {
    const p = fixture('open');
    expect(setStatus(p.id, 'applied', 'merged fixture', 'fleet host merge (standing grant)')).toBe(true);
    expect(readMergeOutcomes()).toHaveLength(1);
    const [outcome] = readMergeOutcomes();
    expect(outcome).toMatchObject({ itemId: p.workItemId, merged: true, costUsd: 0.75 });
    expect(outcome.wallMs).toBeGreaterThan(0);
    expect(Object.keys(outcome).sort()).toEqual(['costUsd', 'itemId', 'merged', 'wallMs']);
    expect(readFileSync(mergeOutcomesPath(), 'utf8')).not.toContain(secret);
    expect(banditStatus(cfg).stats.local).toMatchObject({ pulls: 1, merges: 1, costUsd: 0.75 });
  });

  it.each(['merged', 'closed'] as const)('accounts %s once with dispatch-to-finish wall time', async state => {
    const p = fixture(state, 'frontier');
    const finished = { ...p, status: state === 'merged' ? 'applied' : 'rejected' } as Proposal;
    await recordProposalBanditOutcome(finished, end);
    await recordProposalBanditOutcome(finished, end + 60_000);
    expect(readMergeOutcomes()).toEqual([{ itemId: p.workItemId, merged: state === 'merged', costUsd: 0.75, wallMs: 3_600_000 }]);
    expect(banditStatus(cfg).stats.frontier).toEqual({ pulls: 1, merges: state === 'merged' ? 1 : 0, costUsd: 0.75, hours: 1 });
  });

  it('recovers PR exits after an earlier proposal decision without counting sweep delay', async () => {
    const p = fixture('closed');
    await reconcileBanditOutcomes();
    expect(readMergeOutcomes()).toEqual([{ itemId: p.workItemId, merged: false, costUsd: 0.75, wallMs: 3_600_000 }]);
    await reconcileBanditOutcomes();
    expect(readMergeOutcomes()).toHaveLength(1);
  });

  it('does not treat generic apply or rejection as a PR outcome', async () => {
    const p = fixture();
    await recordProposalBanditOutcome({ ...p, status: 'applied' }, end);
    await recordProposalBanditOutcome({ ...p, status: 'rejected' }, end);
    expect(readMergeOutcomes()).toEqual([]);
  });

  it('records observed human PR closure before the merge pass persists its state', async () => {
    const p = fixture();
    await recordProposalBanditOutcome({ ...p, status: 'rejected', decisionReason: 'fleet PR closed on GitHub' }, end);
    expect(readMergeOutcomes()[0]).toMatchObject({ merged: false, wallMs: 3_600_000 });
  });

  it('stays off without explicit configuration', async () => {
    const p = fixture('merged');
    writeFileSync(join(homedir(), '.ashlr', 'config.json'), '{}');
    await recordProposalBanditOutcome({ ...p, status: 'applied' }, end);
    expect(readMergeOutcomes()).toEqual([]);
    expect(banditStatus({} as AshlrConfig).reason).toBe('disabled');
  });

  it('gives unknown engines no evidence', async () => {
    const p = fixture('merged', 'unclassified');
    await recordProposalBanditOutcome({ ...p, status: 'applied' }, end);
    expect(readMergeOutcomes()).toEqual([]);
  });

  it.each([undefined, NaN, -1])('does not invent zero cost for missing/invalid run cost %s', async cost => {
    const p = fixture('merged');
    writeFileSync(join(homedir(), '.ashlr', 'runs', 'fixture-run.json'), JSON.stringify({ id: 'fixture-run', tasks: [], usage: { estCostUsd: cost } }));
    await recordProposalBanditOutcome({ ...p, status: 'applied' }, end);
    expect(readMergeOutcomes()).toEqual([]);
  });

  it('uses the linked swarm ledger when the producer was a swarm', async () => {
    const p = fixture('merged');
    rmSync(join(homedir(), '.ashlr', 'runs', 'fixture-run.json'));
    mkdirSync(join(homedir(), '.ashlr', 'swarms'), { recursive: true });
    writeFileSync(join(homedir(), '.ashlr', 'swarms', 'fixture-run.json'), JSON.stringify({ id: 'fixture-run', usage: { estCostUsd: 1.25 }, goal: secret }));
    await recordProposalBanditOutcome({ ...p, status: 'applied' }, end);
    expect(readMergeOutcomes()[0]).toMatchObject({ costUsd: 1.25 });
    expect(readFileSync(mergeOutcomesPath(), 'utf8')).not.toContain(secret);
  });

  it('preserves measured zero-dollar local cost', async () => {
    const p = fixture('merged');
    writeFileSync(join(homedir(), '.ashlr', 'runs', 'fixture-run.json'), JSON.stringify({ id: 'fixture-run', usage: { estCostUsd: 0 } }));
    await recordProposalBanditOutcome({ ...p, status: 'applied' }, end);
    expect(readMergeOutcomes()).toHaveLength(1);
    expect(banditStatus(cfg).stats.local.costUsd).toBe(0);
  });

  it('refuses credential-shaped item ids instead of persisting them', async () => {
    const p = fixture('merged');
    const ledger = JSON.parse(readFileSync(routingLedgerPath(), 'utf8'));
    ledger.entries[0].itemId = secret;
    writeFileSync(routingLedgerPath(), JSON.stringify(ledger));
    await recordProposalBanditOutcome({ ...p, status: 'applied', workItemId: secret }, end);
    expect(readMergeOutcomes()).toEqual([]);
  });

  it('doctor warns for cold start and never fails when optional learning is off', () => {
    expect(checkBandit(cfg)).toMatchObject({ id: 'bandit', status: 'warn' });
    expect(checkBandit({} as AshlrConfig)).toMatchObject({ status: 'pass' });
  });
});
