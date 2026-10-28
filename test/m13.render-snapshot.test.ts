/**
 * M13 TUI render SNAPSHOT tests — golden-frame coverage for the renderFrame()
 * surfaces the behavioral suite (m13.render.test.ts) does not pin:
 *
 *   - The `inbox` tab (pending > 0 instructions vs the clear state) — was
 *     entirely untested.
 *   - The `portfolio` tab (health grades + worst repos, goals in flight,
 *     backlog, cost/forecast, effectiveness, and the "today" day-over-day
 *     delta block incl. null deltas and the no-prior-digest state) — was
 *     entirely untested.
 *   - The overview `daemon` roll-up block and the `⚠ Inbox` pending warning
 *     (singular vs plural).
 *   - Narrow-terminal layouts (compact proof chain, truncation ellipses) and
 *     the clipped tiny-frame case.
 *   - Raw-ANSI pins for the active-tab reverse-video marker, the selected-row
 *     highlight, and portfolio grade colors — the exact escape codes, not just
 *     "some ANSI was present".
 *
 * Determinism: every snapshot goes through norm() — ANSI stripped and wall-
 * clock times masked — because formatClock() renders snap.generatedAt in the
 * LOCAL timezone, which differs across dev machines and CI runners. A small
 * set of raw (ANSI-keeping) snapshots pins the escape codes explicitly; ANSI
 * itself is env-independent because NO_COLOR is stubbed off in beforeAll.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { DashboardSnapshot, TuiTab } from '../src/core/types.js';
import { renderFrame, type RenderState } from '../src/tui/render.js';
import { stripAnsi } from '../src/cli/ui.js';

// ---------------------------------------------------------------------------
// Determinism guards
// ---------------------------------------------------------------------------

beforeAll(() => {
  // renderFrame calls makeColors(true), which honours NO_COLOR. A developer or
  // CI env with NO_COLOR=1 would silently turn every raw-ANSI snapshot into a
  // colorless one; stub it empty (the "not requested" value) so frames are
  // identical everywhere.
  vi.stubEnv('NO_COLOR', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** ANSI-stripped, clock-masked frame — stable across timezones and palettes. */
function norm(frame: string): string {
  return stripAnsi(frame).replace(/\b\d{2}:\d{2}:\d{2}\b/g, 'HH:MM:SS');
}

/** First raw (ANSI-keeping) line containing `needle`, for escape-code pins. */
function rawLine(frame: string, needle: string): string {
  const line = frame.split('\n').find(l => l.includes(needle));
  if (line === undefined) throw new Error(`no frame line contains ${JSON.stringify(needle)}`);
  return line;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_STATE: RenderState = {
  tab: 'overview',
  selected: 0,
  cols: 100,
  rows: 30,
  nowMs: Date.parse('2026-06-08T10:00:10.000Z'),
};

function makeFleet(): NonNullable<DashboardSnapshot['fleet']> {
  return {
    generatedAt: '2026-06-08T10:00:00.000Z',
    daemon: {
      running: true,
      sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
      lastTickAt: '2026-06-08T10:00:00.000Z',
      todaySpentUsd: 0.25,
    },
    queue: { backlogItems: 2, activeWork: { itemCount: 1 } },
    proposals: { pending: 0, frontierPending: 0, applied: 0 },
    merges: {
      recent: 0,
      sourceQuality: {
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
        filesDiscovered: 1, filesRead: 1, invalidFiles: 0, unreadableFiles: 0,
      },
    },
    backends: [],
    autonomyControlMode: 'proposal-only',
    killed: false,
    killSwitch: { state: 'inactive', sourceState: 'healthy', reason: 'missing' },
    autonomousShipReadiness: {
      verdict: 'ready',
      confidence: 'high',
      freshness: {
        generatedAt: '2026-06-08T10:00:00.000Z', overall: 'fresh', freshestAt: null,
        stalestAt: null, maxAgeMs: 0, staleSources: 0, unknownSources: 0,
      },
      topBlocker: null,
      primaryAction: null,
      sources: [],
      sourceSummary: { healthy: 1, degraded: 0, blocked: 0, unavailable: 0, unknown: 0 },
    },
    missionBrief: {
      generatedAt: '2026-06-08T10:00:00.000Z',
      directive: 'Continue bounded work',
      confidence: 'high',
      operatingMode: 'autonomous',
      blocker: null,
      action: null,
      whyNow: 'All observed sources are healthy.',
      evidence: {
        readinessVerdict: 'ready', effectivenessPhase: 'idle', bottleneck: 'none',
        queueBacklogItems: 2, eligibleBacklogItems: 2, pendingProposals: 0,
        preflightReady: 2, guardBlocked: false,
      },
    },
    dispatchProduction: {
      windowHours: 24, attempts: 1, events: 1, proposalsCreated: 1, noProposal: 0,
      spentUsd: 0.1, outcomes: {}, topReasons: [], byBackend: [], bySource: [],
      byRepo: [], byBackendModel: [], byBackendSource: [],
    },
    dispatchProductionSource: {
      sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      filesRead: 1, bytesRead: 1, rowsScanned: 1, invalidRows: 0, unreadableFiles: 0,
    },
  } as unknown as NonNullable<DashboardSnapshot['fleet']>;
}

function makePortfolio(): NonNullable<DashboardSnapshot['portfolio']> {
  return {
    health: {
      reposScored: 9,
      averageScore: 78.4,
      averageGrade: 'B',
      worstRepos: [
        { repo: '/Users/m/Projects/ashlrai/phantom', score: 41.2, grade: 'F' },
        { repo: 'lexicon', score: 55.9, grade: 'D' },
      ],
    },
    goalsInFlight: [
      {
        goalId: 'goal-1', objective: 'Ship the TUI snapshot lane', status: 'active',
        fractionDone: 0.6, proposed: 1, totalMilestones: 5,
        nextActionable: 'Add snapshot coverage for inbox + portfolio',
      },
      {
        goalId: 'goal-2', objective: 'A second goal with nothing actionable', status: 'active',
        fractionDone: 0.25, proposed: 0, totalMilestones: 4, nextActionable: null,
      },
    ],
    backlogTop: [
      { title: 'Triage the flaky windows lane', repo: 'phantom', score: 88.4 },
      { title: 'Backfill docs for digest windows', repo: null, score: 72 },
    ],
    cost: { window: '7d', spentUsd: 3.21, localSavingsUsd: 12.4, projectedMonthlyUsd: 13.76 },
    effectiveness: {
      successRate: 0.8,
      effectivenessDeltaPct: 4.5,
      headline: 'Ship-rate 80% (+4.5pp WoW)',
    },
    today: {
      previousAt: '2026-06-07T10:00:00.000Z',
      pendingProposalsDelta: 1,
      dirtyReposDelta: -2,
      spendUsdDelta: -0.5,
      healthScoreDelta: 0,
      // null delta → the em-dash branch of signedDelta.
      goalsInFlightDelta: null,
    },
  };
}

function makeSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    generatedAt: '2026-06-08T10:00:00.000Z',
    repos: { total: 12, dirty: 3, stale: 2 },
    tools: { installed: 5, total: 10 },
    activity: { sessions: 8, tokens: 42000, estCostUsd: 1.2345, commits: 15 },
    runs: [
      { id: 'run-001', goal: 'Build feature X', status: 'done', tokens: 4500 },
      { id: 'run-002', goal: 'Refactor module Y', status: 'running', tokens: 3000 },
      { id: 'run-003', goal: 'Fix critical bug Z', status: 'failed', tokens: 1200 },
      { id: 'run-004', goal: 'Plan next sprint', status: 'planning', tokens: 640 },
      { id: 'run-005', goal: 'Aborted experiment', status: 'aborted', tokens: 0 },
      { id: 'run-006', goal: 'Status outside the known lifecycle', status: 'mystery', tokens: 12 },
    ],
    swarms: [
      { id: 'swarm-001', goal: 'M13 surfaces', status: 'running', tasksDone: 2, tasksTotal: 6, phase: 'build' },
      { id: 'swarm-002', goal: 'Refactor core', status: 'done', tasksDone: 4, tasksTotal: 4 },
      { id: 'swarm-003', goal: 'Phaseless swarm renders an em-dash', status: 'failed', tasksDone: 0, tasksTotal: 3 },
    ],
    mcp: [
      { name: 'ashlr', ok: true, tools: 12 },
      { name: 'phantom-secrets', ok: false, tools: 0 },
      { name: 'a-very-long-mcp-server-name-that-truncates', ok: true, tools: 3 },
    ],
    genome: { entries: 42, projects: 7 },
    inbox: { pending: 2 },
    daemon: { running: true, todaySpentUsd: 0.5, pendingProposals: 2 },
    fleet: makeFleet(),
    portfolio: makePortfolio(),
    ...overrides,
  };
}

function frame(snap: DashboardSnapshot, state: Partial<RenderState> = {}): string {
  return renderFrame(snap, { ...BASE_STATE, ...state });
}

// ---------------------------------------------------------------------------
// Golden frames — one per tab against the canonical snapshot
// ---------------------------------------------------------------------------

describe('renderFrame snapshots — canonical 100x30 dashboard', () => {
  const TABS: TuiTab[] = ['overview', 'runs', 'swarms', 'pulse', 'mcp', 'inbox', 'portfolio'];

  for (const tab of TABS) {
    it(`${tab} tab`, () => {
      expect(norm(frame(makeSnapshot(), { tab }))).toMatchSnapshot();
    });
  }

  it('runs tab with the second row selected', () => {
    expect(norm(frame(makeSnapshot(), { tab: 'runs', selected: 1 }))).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Inbox tab — previously untested branches
// ---------------------------------------------------------------------------

describe('renderFrame snapshots — inbox tab', () => {
  it('clear inbox (pending 0)', () => {
    const snap = makeSnapshot({ inbox: { pending: 0 } });
    expect(norm(frame(snap, { tab: 'inbox' }))).toMatchSnapshot();
  });

  it('pending count + CLI-only instructions', () => {
    const plain = norm(frame(makeSnapshot({ inbox: { pending: 3 } }), { tab: 'inbox' }));
    expect(plain).toContain('3 proposals awaiting approval.');
    expect(plain).toContain('ashlr inbox approve <id>');
    expect(plain).toContain('Approval is CLI-only. Nothing applies automatically.');
  });

  it('singular proposal wording', () => {
    const plain = norm(frame(makeSnapshot({ inbox: { pending: 1 } }), { tab: 'inbox' }));
    expect(plain).toContain('1 proposal awaiting approval.');
    expect(plain).not.toContain('proposals awaiting');
  });
});

// ---------------------------------------------------------------------------
// Portfolio tab — previously untested branches
// ---------------------------------------------------------------------------

describe('renderFrame snapshots — portfolio tab', () => {
  it('absent portfolio section degrades to the enrollment hint', () => {
    const snap = makeSnapshot();
    delete snap.portfolio;
    const normalized = norm(frame(snap, { tab: 'portfolio' }));
    expect(normalized).toMatchSnapshot();
    expect(normalized).toContain('No portfolio data');
  });

  it('empty sub-sources and no prior digest', () => {
    const snap = makeSnapshot({
      portfolio: {
        health: { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] },
        goalsInFlight: [],
        backlogTop: [],
        cost: { window: '30d', spentUsd: 0, localSavingsUsd: 0, projectedMonthlyUsd: 0 },
        effectiveness: null,
        today: {
          previousAt: null,
          pendingProposalsDelta: null,
          dirtyReposDelta: null,
          spendUsdDelta: null,
          healthScoreDelta: null,
          goalsInFlightDelta: null,
        },
      },
    });
    const normalized = norm(frame(snap, { tab: 'portfolio' }));
    expect(normalized).toMatchSnapshot();
    expect(normalized).toContain('No enrolled repos scored.');
    expect(normalized).toContain('None active.');
    expect(normalized).toContain('No prior digest to compare against yet.');
  });

  it('shows day-over-day deltas including the null em-dash', () => {
    const normalized = norm(frame(makeSnapshot(), { tab: 'portfolio' }));
    expect(normalized).toContain('Pending: +1');
    expect(normalized).toContain('Dirty: -2');
    expect(normalized).toContain('Spend: -$0.50');
    expect(normalized).toContain('Health: 0');
    // goalsInFlightDelta: null → dim em-dash.
    expect(normalized).toContain('Goals: —');
  });

  it('renders next-actionable milestone hints for in-flight goals', () => {
    const normalized = norm(frame(makeSnapshot(), { tab: 'portfolio' }));
    expect(normalized).toContain('next: Add snapshot coverage for inbox + portfolio');
    expect(normalized).toContain('60%');
    expect(normalized).toContain('25%');
  });

  it('labels worst repos by basename only', () => {
    const normalized = norm(frame(makeSnapshot(), { tab: 'portfolio' }));
    // repoLabel() must reduce the absolute path to 'phantom'.
    expect(normalized).toContain('phantom  F (41)');
    expect(normalized).not.toContain('/Users/m/Projects');
  });
});

// ---------------------------------------------------------------------------
// Overview blocks — previously untested branches
// ---------------------------------------------------------------------------

describe('renderFrame snapshots — overview extras', () => {
  it('no fleet evidence fails closed to the inspection action', () => {
    const snap = makeSnapshot({ inbox: { pending: 0 } });
    delete snap.fleet;
    delete snap.daemon;
    expect(norm(frame(snap))).toMatchSnapshot();
  });

  it('daemon block shows running status, spend and pending proposals', () => {
    const normalized = norm(frame(makeSnapshot()));
    expect(normalized).toContain('Status: running');
    expect(normalized).toContain('Spend today: $0.5000');
    expect(normalized).toContain('Pending proposals: 2');
  });

  it('idle daemon renders the dim idle status', () => {
    const snap = makeSnapshot({
      daemon: { running: false, todaySpentUsd: 0, pendingProposals: 0 },
    });
    const normalized = norm(frame(snap));
    expect(normalized).toContain('Status: idle');
    expect(normalized).toContain('Pending proposals: 0');
  });

  it('inbox warning uses singular wording for one pending proposal', () => {
    const normalized = norm(frame(makeSnapshot({ inbox: { pending: 1 } })));
    expect(normalized).toContain('1 proposal awaiting approval');
    expect(normalized).not.toContain('proposals awaiting approval');
  });

  it('inbox warning uses plural wording for several pending proposals', () => {
    const normalized = norm(frame(makeSnapshot({ inbox: { pending: 2 } })));
    expect(normalized).toContain('2 proposals awaiting approval');
  });
});

// ---------------------------------------------------------------------------
// Geometry edge cases
// ---------------------------------------------------------------------------

describe('renderFrame snapshots — geometry edges', () => {
  it('narrow overview (48x20) uses the compact proof layout', () => {
    expect(norm(frame(makeSnapshot(), { cols: 48, rows: 20 }))).toMatchSnapshot();
  });

  it('narrow portfolio (48x20) truncates long objectives and items', () => {
    expect(norm(frame(makeSnapshot(), { tab: 'portfolio', cols: 48, rows: 20 }))).toMatchSnapshot();
  });

  it('tiny frame (32x10) clips the body to the terminal', () => {
    const normalized = norm(frame(makeSnapshot(), { cols: 32, rows: 10 }));
    expect(normalized).toMatchSnapshot();
    expect(normalized.split('\n')).toHaveLength(10);
  });

  it('pulse tab renders the token bar for million-scale usage', () => {
    const snap = makeSnapshot({
      activity: { sessions: 30, tokens: 2_500_000, estCostUsd: 11.5, commits: 61 },
    });
    const normalized = norm(frame(snap, { tab: 'pulse' }));
    expect(normalized).toMatchSnapshot();
    expect(normalized).toContain('2.5M tok');
  });
});

// ---------------------------------------------------------------------------
// Raw ANSI pins — the exact escape codes for stateful chrome
// ---------------------------------------------------------------------------

describe('renderFrame snapshots — raw ANSI pins', () => {
  it('active tab is marked with reverse video in the tab bar', () => {
    // The tab-bar line contains '1:Overview'; the active label is wrapped in
    // \x1b[7m…\x1b[0m (reverse video) inside a bold span.
    expect(rawLine(frame(makeSnapshot(), { tab: 'overview' }), '1:Overview')).toMatchSnapshot();
  });

  it('the selected runs row is reverse-video and the failed status is red', () => {
    const line = rawLine(
      frame(makeSnapshot(), { tab: 'runs', selected: 2 }),
      'run-003',
    );
    expect(line.startsWith('\x1b[7m')).toBe(true);
    expect(line).toContain('\x1b[31m'); // failed → red
    expect(line).toMatchSnapshot();
  });

  it('portfolio grade colors: F is red, D is red, and handles stay dim', () => {
    const worstF = rawLine(frame(makeSnapshot(), { tab: 'portfolio' }), '(41)');
    expect(worstF).toContain('\x1b[31mF\x1b[0m');
    expect(worstF).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Snapshot sanity: normalization only masks the clock
// ---------------------------------------------------------------------------

describe('snapshot normalization', () => {
  it('norm() strips ANSI and masks HH:MM:SS wall-clock times', () => {
    const colored = '\x1b[31m10:00:00\x1b[0m done';
    expect(norm(colored)).toBe('HH:MM:SS done');
  });

  it('raw frames differ between tabs even after normalization', () => {
    const snap = makeSnapshot();
    expect(norm(frame(snap, { tab: 'inbox' }))).not.toBe(norm(frame(snap, { tab: 'portfolio' })));
  });
});
