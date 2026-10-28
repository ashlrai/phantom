/**
 * M13 TUI interactive-loop tests — hermetic coverage of runInteractive() in
 * src/tui/app.ts, the path m13.tui-once.test.ts deliberately never reaches:
 *
 *   - Alt-screen enter/leave, cursor hide/show, raw-mode toggling.
 *   - Raw keypress decoding: q/Q/Ctrl-C quit, 1-7 tab select, tab/shift-tab
 *     cycling (with wrap-around), j/k + arrow-key row movement (clamped),
 *     r/R/enter refresh, ignored keys.
 *   - SIGWINCH repaint (clear + redraw).
 *   - Paint dedup (identical frames are not rewritten).
 *   - Degraded first paint when the initial snapshot fails.
 *   - GUARANTEED terminal + listener restoration on quit.
 *
 * Hermetic: buildSnapshot is mocked, TTY flags and setRawMode are faked on the
 * real process streams, and keys are driven by emitting 'data' events on
 * process.stdin — no PTY, no child process, no real ~/.ashlr reads.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, DashboardSnapshot } from '../src/core/types.js';
import { runTui } from '../src/tui/app.js';
import { stripAnsi } from '../src/cli/ui.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

function makeSnapshot(): DashboardSnapshot {
  return {
    generatedAt: '2026-06-08T10:00:00.000Z',
    repos: { total: 3, dirty: 1, stale: 0 },
    tools: { installed: 2, total: 5 },
    activity: { sessions: 2, tokens: 8000, estCostUsd: 0.15, commits: 4 },
    runs: [
      { id: 'run-001', goal: 'Test goal alpha', status: 'done', tokens: 1000 },
      { id: 'run-002', goal: 'Test goal beta', status: 'running', tokens: 500 },
      { id: 'run-003', goal: 'Test goal gamma', status: 'failed', tokens: 250 },
    ],
    swarms: [
      { id: 'swarm-001', goal: 'Test swarm beta', status: 'running', tasksDone: 1, tasksTotal: 3, phase: 'build' },
    ],
    mcp: [
      { name: 'ashlr', ok: true, tools: 8 },
      { name: 'phantom-secrets', ok: false, tools: 0 },
    ],
    genome: { entries: 10, projects: 3 },
    inbox: { pending: 0 },
  };
}

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => makeSnapshot()),
}));

// ---------------------------------------------------------------------------
// Terminal control sequences (mirrors src/tui/app.ts — kept local)
// ---------------------------------------------------------------------------

const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_LEAVE = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';
const REVERSE_VIDEO = '\x1b[7m';

// ---------------------------------------------------------------------------
// Stdout capture — NOT passed through: interactive repaints would flood the
// test log with full-screen ANSI frames (unlike the single --once frame).
// ---------------------------------------------------------------------------

let stdoutChunks: string[] = [];

function captureStdout(): void {
  stdoutChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    },
  );
}

function captured(): string {
  return stdoutChunks.join('');
}

function clearCaptured(): void {
  stdoutChunks = [];
}

// ---------------------------------------------------------------------------
// TTY faking — save/restore property descriptors exactly
// ---------------------------------------------------------------------------

const savedDescriptors: [object, string, PropertyDescriptor | undefined][] = [];

function fakeProp(obj: object, prop: string, value: unknown): void {
  savedDescriptors.push([obj, prop, Object.getOwnPropertyDescriptor(obj, prop)]);
  Object.defineProperty(obj, prop, { value, configurable: true, writable: true });
}

function restoreProps(): void {
  while (savedDescriptors.length > 0) {
    const [obj, prop, desc] = savedDescriptors.pop()!;
    if (desc === undefined) {
      delete (obj as Record<string, unknown>)[prop];
    } else {
      Object.defineProperty(obj, prop, desc);
    }
  }
}

let setRawMode: ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** Two macrotask turns: enough for safeSnapshot() to resolve + enter + paint. */
async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

/**
 * A live interactive session. `done` resolves with the exit code once the TUI
 * quits. NOTE: it MUST be wrapped — `async () => promise` flattens the inner
 * promise, which would make `await start()` block until the TUI quits (i.e.
 * deadlock: the quit key can only be sent after start() returns).
 */
interface Session {
  done: Promise<number>;
}

/** Start the interactive loop and wait for the first paint. */
async function start(cfg: AshlrConfig = makeConfig()): Promise<Session> {
  const done = runTui(cfg, { once: false });
  await settle();
  return { done };
}

/** Deliver a raw keypress exactly as the terminal would. */
function key(k: string): void {
  process.stdin.emit('data', k);
}

/** Quit and await the promised exit code. */
async function quit(s: Session): Promise<number> {
  key('q');
  return s.done;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let baseline: Record<string, number>;

const noopStdinError = (): void => {};

beforeAll(() => {
  // enterTerminal() calls process.stdin.resume(). In a forked test worker
  // stdin may be a pipe whose other end is closed, which can surface an async
  // 'error' event; with no listener that would be an uncaughtException. The
  // app (correctly) never installs one for real TTYs — the guard belongs to
  // the fake harness, not the code under test.
  process.stdin.on('error', noopStdinError);
});

afterAll(() => {
  process.stdin.removeListener('error', noopStdinError);
});

beforeEach(async () => {
  captureStdout();
  vi.stubEnv('NO_COLOR', '');

  // Fake a fully interactive terminal on the real process streams.
  fakeProp(process.stdout, 'isTTY', true);
  fakeProp(process.stdin, 'isTTY', true);
  setRawMode = vi.fn(() => process.stdin);
  fakeProp(process.stdin, 'setRawMode', setRawMode);
  // Deterministic geometry for every paint.
  fakeProp(process.stdout, 'columns', 100);
  fakeProp(process.stdout, 'rows', 30);

  baseline = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGWINCH: process.listenerCount('SIGWINCH'),
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
    stdinData: process.stdin.listenerCount('data'),
  };

  const { buildSnapshot } = await import('../src/core/dashboard.js');
  vi.mocked(buildSnapshot).mockReset().mockResolvedValue(makeSnapshot());
});

afterEach(() => {
  restoreProps();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Enter / quit lifecycle
// ---------------------------------------------------------------------------

describe('runInteractive — terminal lifecycle', () => {
  it('enters the alt-screen, hides the cursor and paints the overview frame', async () => {
    const s = await start();
    const out = captured();
    expect(out).toContain(ALT_SCREEN_ENTER);
    expect(out).toContain(CURSOR_HIDE);
    expect(out).toContain(CLEAR_SCREEN);
    const plain = stripAnsi(out);
    expect(plain).toContain('ashlr hub');
    expect(plain).toContain('Overview');
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(await quit(s)).toBe(0);
  });

  it('q quits: shows the cursor, leaves the alt-screen, restores raw mode, resolves 0', async () => {
    const s = await start();
    clearCaptured();
    const code = await quit(s);
    expect(code).toBe(0);
    // Cursor-show + alt-screen-leave is the LAST thing written.
    expect(stdoutChunks[stdoutChunks.length - 1]).toBe(CURSOR_SHOW + ALT_SCREEN_LEAVE);
    expect(setRawMode).toHaveBeenCalledWith(false);
  });

  it.each(['Q', '\x03'])('quit key %j also resolves 0 and restores', async (k) => {
    const s = await start();
    key(k);
    expect(await s.done).toBe(0);
    expect(captured()).toContain(CURSOR_SHOW + ALT_SCREEN_LEAVE);
  });
});

// ---------------------------------------------------------------------------
// Keypress decoding — tabs
// ---------------------------------------------------------------------------

describe('runInteractive — tab selection keys', () => {
  it('digit keys 1-7 select the matching tab', async () => {
    const s = await start();

    clearCaptured();
    key('2');
    expect(stripAnsi(captured())).toContain('Test goal alpha'); // runs rows

    clearCaptured();
    key('3');
    expect(stripAnsi(captured())).toContain('Test swarm beta'); // swarms rows

    clearCaptured();
    key('5');
    expect(stripAnsi(captured())).toContain('phantom-secrets'); // mcp rows

    clearCaptured();
    key('6');
    expect(stripAnsi(captured())).toContain('Inbox — Pending Approvals');

    clearCaptured();
    key('7');
    expect(stripAnsi(captured())).toContain('No portfolio data'); // body, not the tab bar

    clearCaptured();
    key('1');
    expect(stripAnsi(captured())).toContain('Operator briefing');

    expect(await quit(s)).toBe(0);
  });

  it('out-of-range digits and unknown keys are no-ops (no repaint)', async () => {
    const s = await start();
    clearCaptured();
    key('8');
    key('9');
    key('0');
    key('x');
    key(' ');
    expect(captured()).toBe('');
    expect(await quit(s)).toBe(0);
  });

  it('tab and shift-tab cycle forward and backward with wrap-around', async () => {
    const s = await start();

    clearCaptured();
    key('\t'); // overview → runs
    expect(stripAnsi(captured())).toContain('Test goal alpha');

    clearCaptured();
    key('\t'); // runs → swarms
    expect(stripAnsi(captured())).toContain('Test swarm beta');

    clearCaptured();
    key('\x1b[Z'); // swarms → runs
    expect(stripAnsi(captured())).toContain('Test goal alpha');

    clearCaptured();
    key('\x1b[Z'); // runs → overview
    key('\x1b[Z'); // overview → wraps to portfolio (last tab)
    expect(stripAnsi(captured())).toContain('No portfolio data');

    expect(await quit(s)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Keypress decoding — selection movement
// ---------------------------------------------------------------------------

describe('runInteractive — j/k row selection', () => {
  function selectedRowNeedle(id: string): RegExp {
    // The selected row is wrapped: \x1b[7m + row text + \x1b[0m.
    return new RegExp(`${REVERSE_VIDEO.replace('[', '\\[')}[^\\n]*${id}`);
  }

  it('j/down and k/up move the highlighted row, clamped at both ends', async () => {
    const s = await start();
    key('2'); // runs tab — 3 rows

    clearCaptured();
    key('j');
    expect(captured()).toMatch(selectedRowNeedle('run-002'));

    clearCaptured();
    key('j'); // bottom row
    key('j'); // clamped — stays
    expect(captured()).toMatch(selectedRowNeedle('run-003'));

    clearCaptured();
    key('k');
    expect(captured()).toMatch(selectedRowNeedle('run-002'));

    clearCaptured();
    key('\x1b[A'); // up arrow → run-001
    key('\x1b[A'); // clamped at top
    expect(captured()).toMatch(selectedRowNeedle('run-001'));

    expect(await quit(s)).toBe(0);
  });

  it('down arrow moves the selection like j', async () => {
    const s = await start();
    key('2');
    clearCaptured();
    key('\x1b[B');
    expect(captured()).toMatch(selectedRowNeedle('run-002'));
    expect(await quit(s)).toBe(0);
  });

  it('j/k are no-ops on tabs with no selectable rows', async () => {
    const s = await start(); // overview — no row selection
    clearCaptured();
    key('j');
    key('k');
    expect(captured()).toBe('');
    expect(await quit(s)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refresh + repaint behavior
// ---------------------------------------------------------------------------

describe('runInteractive — refresh and repaint', () => {
  it('r triggers a snapshot refresh; enter triggers one too', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    const s = await start();
    expect(vi.mocked(buildSnapshot)).toHaveBeenCalledTimes(1);

    key('r');
    await settle();
    expect(vi.mocked(buildSnapshot)).toHaveBeenCalledTimes(2);

    key('\r');
    await settle();
    expect(vi.mocked(buildSnapshot)).toHaveBeenCalledTimes(3);

    expect(await quit(s)).toBe(0);
  });

  it('identical refreshed frames are not rewritten (paint dedup)', async () => {
    const s = await start();
    clearCaptured();
    key('r'); // same fixture → identical frame → dedup drops the repaint
    await settle();
    expect(captured()).toBe('');
    expect(await quit(s)).toBe(0);
  });

  it('SIGWINCH clears the screen and repaints the current frame', async () => {
    const s = await start();
    clearCaptured();
    process.emit('SIGWINCH');
    const out = captured();
    expect(out).toContain(CLEAR_SCREEN);
    expect(out).toContain(CURSOR_HOME);
    expect(stripAnsi(out)).toContain('Operator briefing');
    expect(await quit(s)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Degraded input paths
// ---------------------------------------------------------------------------

describe('runInteractive — degraded inputs', () => {
  it('still paints a frame and quits cleanly when the initial snapshot fails', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockRejectedValue(new Error('snapshot store offline'));

    const s = await start();
    // emptySnapshot() frame still renders the chrome.
    expect(stripAnsi(captured())).toContain('ashlr hub');
    expect(await quit(s)).toBe(0);
  });

  it('a refresh failure degrades the view instead of crashing the loop', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    const s = await start();
    key('2'); // runs tab

    vi.mocked(buildSnapshot).mockRejectedValue(new Error('refresh failed'));
    clearCaptured();
    key('r');
    await settle();
    // safeSnapshot() swallowed the error and repainted the zeroed snapshot.
    expect(stripAnsi(captured())).toContain('(no runs)');
    expect(await quit(s)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Restoration guarantees
// ---------------------------------------------------------------------------

describe('runInteractive — listener and terminal restoration', () => {
  it('wires SIGINT/SIGTERM/SIGWINCH + fatal backstops while running, removes them on quit', async () => {
    const s = await start();
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM + 1);
    expect(process.listenerCount('SIGWINCH')).toBe(baseline.SIGWINCH + 1);
    expect(process.listenerCount('uncaughtException')).toBe(baseline.uncaughtException + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(baseline.unhandledRejection + 1);
    expect(process.stdin.listenerCount('data')).toBe(baseline.stdinData + 1);

    expect(await quit(s)).toBe(0);

    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM);
    expect(process.listenerCount('SIGWINCH')).toBe(baseline.SIGWINCH);
    expect(process.listenerCount('uncaughtException')).toBe(baseline.uncaughtException);
    expect(process.listenerCount('unhandledRejection')).toBe(baseline.unhandledRejection);
    expect(process.stdin.listenerCount('data')).toBe(baseline.stdinData);
  });

  it('restore is idempotent across two sessions in a row', async () => {
    const s1 = await start();
    expect(await quit(s1)).toBe(0);
    const s2 = await start();
    expect(await quit(s2)).toBe(0);
    expect(process.listenerCount('SIGWINCH')).toBe(baseline.SIGWINCH);
    expect(process.stdin.listenerCount('data')).toBe(baseline.stdinData);
  });
});
