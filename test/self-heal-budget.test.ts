/**
 * Self-heal is bounded and resumable: the resident daemon's `self-heal` phase
 * hit its 5-minute deadline (301740ms) because one cycle verified every
 * enrolled repo sequentially (90 s per command) and restarted at the first
 * repo every tick. A cycle now stops starting repos when its budget runs out,
 * caps each repo's check at a per-repo budget, and persists a cursor so the
 * next cycle resumes at the first repo it did not reach.
 *
 * Hermetic: HOME is a temp dir; verify commands and enrollment are mocked; the
 * budget clock is injected, so no real time passes and nothing real runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const origHome = process.env.HOME;
let tmpHome: string;

const mockDetectVerifyCommands = vi.fn();
const mockRunVerifyCommand = vi.fn();
vi.mock('../src/core/run/verify-commands.js', () => ({
  detectVerifyCommands: (...args: unknown[]) => mockDetectVerifyCommands(...args),
  runVerifyCommand: (...args: unknown[]) => mockRunVerifyCommand(...args),
  runVerifyCommandAsync: (...args: unknown[]) => mockRunVerifyCommand(...args),
}));

const mockListEnrolled = vi.fn();
vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/policy.js')>();
  return {
    ...actual,
    listEnrolled: () => mockListEnrolled(),
    isEnrolled: () => true,
    killSwitchOn: () => false,
    readRegistry: vi.fn(() => ({ repos: [] })),
  };
});

const {
  runSelfHealCycle,
  readSelfHealCursor,
  detectBreakage,
  SELF_HEAL_CYCLE_BUDGET_MS,
} = await import('../src/core/fleet/self-heal.js');
const { TICK_PHASE_MAINTENANCE_MS } = await import('../src/core/daemon/tick-phases.js');

const TEST_VC = { kind: 'test' as const, cmd: ['npm', 'test'] };
const OK = { ok: true, command: 'npm test', exitCode: 0, output: '', timedOut: false };

let clockMs = 0;
const now = () => clockMs;
let verifiedRepos: string[] = [];
let timeouts: number[] = [];

function enroll(count: number): string[] {
  const repos = Array.from({ length: count }, (_, i) => {
    const dir = path.join(tmpHome, `repo-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  mockListEnrolled.mockReturnValue(repos);
  return repos;
}

beforeEach(() => {
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-budget-')));
  process.env.HOME = tmpHome;
  vi.resetAllMocks();
  clockMs = 1_000_000;
  verifiedRepos = [];
  timeouts = [];
  mockDetectVerifyCommands.mockReturnValue([TEST_VC]);
  // Every verify command takes 90 s of (simulated) wall time — the per-command ceiling.
  mockRunVerifyCommand.mockImplementation((_vc: unknown, repoDir: string, _cfg: unknown, opts: { timeoutMs: number }) => {
    verifiedRepos.push(repoDir);
    timeouts.push(opts.timeoutMs);
    clockMs += Math.min(90_000, opts.timeoutMs);
    return Promise.resolve(OK);
  });
});

afterEach(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('self-heal cycle budget', () => {
  it('stays inside the maintenance phase deadline however many repos are enrolled', async () => {
    enroll(12);
    const startedAt = clockMs;
    const result = await runSelfHealCycle({ foundry: {} }, { now });
    // 12 repos × 90 s would be 18 minutes; the cycle stops well inside the 5-minute phase.
    expect(clockMs - startedAt).toBeLessThan(TICK_PHASE_MAINTENANCE_MS);
    expect(clockMs - startedAt).toBeLessThanOrEqual(SELF_HEAL_CYCLE_BUDGET_MS);
    expect(result.budgetExhausted).toBe(true);
    expect(result.checked).toBeLessThan(12);
    expect(result.checked + (result.deferred ?? 0)).toBe(12);
  });

  it('resumes the next cycle at the first repo the previous one did not reach', async () => {
    const repos = enroll(7);
    const first = await runSelfHealCycle({ foundry: {} }, { now, budgetMs: 200_000 });
    expect(first.checked).toBe(3);
    expect(first.deferred).toBe(4);
    expect(verifiedRepos).toEqual(repos.slice(0, 3));
    expect(readSelfHealCursor()).toBe(repos[2]);

    verifiedRepos = [];
    await runSelfHealCycle({ foundry: {} }, { now, budgetMs: 200_000 });
    expect(verifiedRepos).toEqual(repos.slice(3, 6));

    verifiedRepos = [];
    await runSelfHealCycle({ foundry: {} }, { now, budgetMs: 200_000 });
    // Wraps around: every repo is covered within three bounded cycles.
    expect(verifiedRepos).toEqual([repos[6], repos[0], repos[1]]);
  });

  it('caps each repo at its per-repo budget and never reports a cut-short repo green', async () => {
    const [repo] = enroll(1);
    mockDetectVerifyCommands.mockReturnValue([TEST_VC, { kind: 'typecheck', cmd: ['tsc'] }, TEST_VC]);
    const breakage = await detectBreakage(repo!, { foundry: {} }, { budgetMs: 100_000, now });
    expect(timeouts[0]).toBe(90_000);
    expect(timeouts[1]).toBe(10_000);
    expect(timeouts).toHaveLength(2);
    expect(breakage).toMatchObject({ broken: false, verified: false, reason: 'untrusted-verify-result' });
  });

  it('a cycle that finishes its list reports no deferral', async () => {
    enroll(2);
    const result = await runSelfHealCycle({ foundry: {} }, { now });
    expect(result).toMatchObject({ checked: 2, broken: [], healItems: [] });
    expect(result.deferred).toBeUndefined();
    expect(result.budgetExhausted).toBeUndefined();
  });
});
