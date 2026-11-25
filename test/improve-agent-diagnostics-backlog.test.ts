import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENTDIAG_BACKLOG_MAX_ITEMS,
  AGENTDIAG_MIN_DAYS,
  AGENTDIAG_MIN_ROWS,
  AGENTDIAG_WINDOW_MS,
  agentDiagnosticsBacklogItems,
  foldAgentDiagnosticCells,
  parseAgentDiagnosticLine,
  parseAgentDiagnosticRows,
  type AgentDiagnosticRow,
} from '../src/core/improve/agent-diagnostics-backlog.js';
import { agentDiagnosticsDir } from '../src/core/run/agent-diagnostics.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

const NOW = Date.parse('2026-11-24T15:00:00.000Z');
const CUTOFF = NOW - AGENTDIAG_WINDOW_MS;
const RUNREF = 'a'.repeat(64);
/** Distinct writer-shaped file names: 64 lowercase hex chars + .jsonl. */
const refName = (n: number): string => `${n.toString(16).padStart(64, '0')}.jsonl`;

/** A diagnostic row the way recordAgentDiagnostic's sanitizeRecord emits it. */
const diag = (
  engine: string,
  atMs: number,
  extra: Record<string, unknown> = {},
): string =>
  J({
    schemaVersion: 1,
    ts: new Date(atMs).toISOString(),
    runRef: RUNREF,
    engine,
    ok: false,
    errorClass: 'execution',
    durationMs: 1_000,
    attempt: 1,
    maxAttempts: 3,
    output: { bytes: 4, lines: 1, present: true },
    error: { bytes: 0, lines: 0, present: false },
    ...extra,
  });

const fail = (engine: string, atMs: number, extra: Record<string, unknown> = {}): string =>
  diag(engine, atMs, { ok: false, ...extra });
const pass = (engine: string, atMs: number, extra: Record<string, unknown> = {}): string =>
  diag(engine, atMs, { ok: true, errorClass: 'none', ...extra });

/** A parsed-row fixture for the pure fold. */
const row = (engine: string, atMs: number, over: Partial<AgentDiagnosticRow> = {}): AgentDiagnosticRow => ({
  tsMs: atMs,
  utcDay: new Date(atMs).toISOString().slice(0, 10),
  engine,
  ok: false,
  errorClass: 'execution',
  terminationReason: null,
  configRecoveryAttempts: 0,
  ...over,
});

describe('parseAgentDiagnosticLine', () => {
  it('accepts writer-contract rows and ignores extra fields', () => {
    const parsed = parseAgentDiagnosticLine(fail('claude', NOW - MIN, { attempt: 2, configRecoveryAttempts: 1, future: 'field' }));
    expect(parsed).toMatchObject({
      engine: 'claude',
      ok: false,
      errorClass: 'execution',
      terminationReason: null,
      configRecoveryAttempts: 1,
    });
    expect(parsed!.tsMs).toBe(NOW - MIN);
    expect(parsed!.utcDay).toBe('2026-11-24');
  });

  it('accepts every persisted terminationReason and rejects ones the store drops', () => {
    for (const term of ['backstop-timeout', 'idle-stall', 'loop-stall', 'no-diff-stall', 'clean-exit', 'error-exit']) {
      expect(parseAgentDiagnosticLine(fail('aider', NOW - MIN, { terminationReason: term }))!.terminationReason).toBe(term);
    }
    // 'cancelled' is a TerminationReason but sanitizeRecord never persists it.
    expect(parseAgentDiagnosticLine(fail('aider', NOW - MIN, { terminationReason: 'cancelled' }))).toBeNull();
    expect(parseAgentDiagnosticLine(fail('aider', NOW - MIN, { terminationReason: 'made-up' }))).toBeNull();
  });

  it('rejects rows off the writer contract', () => {
    const bad = [
      'not json at all',
      J({ schemaVersion: 2, ts: new Date(NOW).toISOString(), runRef: RUNREF, engine: 'aider', ok: false, errorClass: 'execution', durationMs: 1, attempt: 1, maxAttempts: 3, output: { bytes: 0, lines: 0, present: false }, error: { bytes: 0, lines: 0, present: false } }),
      diag('aider', NOW - MIN, { ts: 'not-a-date' }),
      diag('aider', NOW - MIN, { runRef: 'xyz' }),
      diag('aider', NOW - MIN, { runRef: 'A'.repeat(64) }),
      diag('aider', NOW - MIN, { engine: 'bad engine!' }),
      diag('aider', NOW - MIN, { ok: 'yes' }),
      diag('aider', NOW - MIN, { errorClass: 'bogus' }),
      diag('aider', NOW - MIN, { durationMs: -1 }),
      diag('aider', NOW - MIN, { attempt: 0 }),
      diag('aider', NOW - MIN, { attempt: 4, maxAttempts: 3 }),
      diag('aider', NOW - MIN, { attempt: 101, maxAttempts: 200 }),
      diag('aider', NOW - MIN, { configRecoveryAttempts: -2 }),
      diag('aider', NOW - MIN, { tokensIn: 'many' }),
      diag('aider', NOW - MIN, { output: { bytes: 4, lines: 1 } }),
      diag('aider', NOW - MIN, { output: { bytes: 0, lines: 0, present: true } }),
      diag('aider', NOW - MIN, { error: 'none' }),
      '[]',
      '',
    ];
    for (const text of bad) expect(parseAgentDiagnosticLine(text)).toBeNull();
  });
});

describe('parseAgentDiagnosticRows', () => {
  it('keeps in-window contract rows and counts the rest', () => {
    const text = [
      fail('aider', NOW - MIN),
      pass('aider', NOW - 2 * MIN),
      fail('aider', NOW - AGENTDIAG_WINDOW_MS - MIN), // outside window
      fail('aider', NOW + MIN), // future
      'garbage',
      diag('aider', NOW - MIN, { schemaVersion: 9 }),
      '',
    ].join('\n');
    const parsed = parseAgentDiagnosticRows(text, CUTOFF, NOW);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.invalid).toBe(2);
  });
});

describe('foldAgentDiagnosticCells', () => {
  const T_OLD = NOW - 2 * DAY - 2 * HOUR; // 2026-11-22
  const T_NEW = NOW - DAY - 3 * HOUR; // 2026-11-23

  it('groups failed rows by (engine, signal) and tracks day spread', () => {
    const cells = foldAgentDiagnosticCells([
      row('aider', T_OLD, { errorClass: 'rate-limit' }),
      row('aider', T_OLD + HOUR, { errorClass: 'rate-limit' }),
      row('aider', T_NEW, { errorClass: 'rate-limit' }),
      row('aider', T_NEW, { errorClass: 'authentication' }),
      row('claude', T_NEW, { errorClass: 'rate-limit' }),
      row('aider', T_NEW, { ok: true, errorClass: 'none' }),
    ]);
    expect(cells.map((c) => [c.engine, c.signal, c.rows, c.days])).toEqual([
      ['aider', 'rate-limit', 3, 2],
      ['aider', 'authentication', 1, 1],
      ['claude', 'rate-limit', 1, 1],
    ]);
    const aider = cells[0]!;
    // engineRuns counts every validated row for the engine: 3 rate-limit
    // + 1 authentication + 1 ok = 5; engineOk = 1, engineFailed = 4.
    expect(aider.engineRuns).toBe(5);
    expect(aider.engineOk).toBe(1);
    expect(aider.engineFailed).toBe(4);
    expect(aider.firstSeen).toBe(new Date(T_OLD).toISOString());
    expect(aider.lastSeen).toBe(new Date(T_NEW).toISOString());
    expect(aider.kind).toBe('failure');
  });

  it('lets a stall-monitor verdict beat the error text class', () => {
    const cells = foldAgentDiagnosticCells([
      row('aider', T_OLD, { errorClass: 'authentication', terminationReason: 'idle-stall' }),
      row('aider', T_NEW, { errorClass: 'none', terminationReason: 'loop-stall' }),
      row('aider', T_NEW, { errorClass: 'execution', terminationReason: 'no-diff-stall' }),
      row('aider', T_NEW, { errorClass: 'rate-limit', terminationReason: 'error-exit' }),
      row('aider', T_NEW, { errorClass: 'none', terminationReason: 'backstop-timeout' }),
      row('aider', T_NEW, { errorClass: 'none', terminationReason: 'clean-exit' }), // contradictory: failed but clean exit
      row('aider', T_NEW, { errorClass: 'none', terminationReason: null }),
    ]);
    // Cells sort by rows desc, then engine, then signal — unclassified
    // leads on its two rows (the clean-exit contradiction + no signal).
    expect(cells.map((c) => [c.signal, c.rows])).toEqual([
      ['unclassified', 2],
      ['backstop-timeout', 1],
      ['idle-stall', 1],
      ['loop-stall', 1],
      ['no-diff-stall', 1],
      ['rate-limit', 1], // errorClass wins over the generic error-exit
    ]);
  });

  it('feeds config-recovery cells on any row that needed repair, ok or not', () => {
    const cells = foldAgentDiagnosticCells([
      row('aider', T_OLD, { ok: true, errorClass: 'none', configRecoveryAttempts: 2 }),
      row('aider', T_OLD + HOUR, { ok: false, errorClass: 'execution', configRecoveryAttempts: 1 }),
      row('aider', T_NEW, { ok: true, errorClass: 'none', configRecoveryAttempts: 3 }),
      row('claude', T_NEW, { ok: true, errorClass: 'none', configRecoveryAttempts: 1 }),
      row('aider', T_NEW, { ok: true, errorClass: 'none' }),
    ]);
    const recovery = cells.find((c) => c.signal === 'config-recovery')!;
    expect(recovery.kind).toBe('config-recovery');
    expect(recovery.rows).toBe(3);
    expect(recovery.days).toBe(2);
    expect(recovery.recoveryAttempts).toBe(6);
    // The failed row still feeds its own failure cell too.
    expect(cells.find((c) => c.engine === 'aider' && c.signal === 'execution')!.rows).toBe(1);
    // claude's single recovery row never reaches the recurring bar here
    // (the fold reports it; the item layer applies the bars).
    expect(cells.find((c) => c.engine === 'claude')!.signal).toBe('config-recovery');
  });

  it('marks truncation as a lower bound', () => {
    const cells = foldAgentDiagnosticCells([row('aider', T_OLD, { errorClass: 'timeout' })], true);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('agentDiagnosticsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    home = await mkdtemp(join(tmpdir(), 'agentdiag-backlog-'));
    process.env.HOME = home;
    delete process.env.ASHLR_HOME;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** Write one diagnostics file and pin its mtime inside the test window. */
  async function runFile(dir: string, name: string, lines: string[], mtimeMs = NOW): Promise<string> {
    const path = join(dir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path, lines.join('\n') + '\n');
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
    return path;
  }

  it('emits an item for a recurring (engine, signal) cell and validates it', async () => {
    const dir = join(home, 'agent-logs');
    // Two rate-limit failures on 2026-11-22, one on 2026-11-23 — across two UTC days.
    await runFile(dir, refName(1), [
      fail('claude', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'rate-limit' }),
      fail('claude', NOW - 2 * DAY - HOUR, { errorClass: 'rate-limit' }),
      fail('claude', NOW - DAY - 3 * HOUR, { errorClass: 'rate-limit' }),
      pass('claude', NOW - DAY),
    ]);
    const items = await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'agent-diagnostics' });
    expect(item!.id).toMatch(/^fleet-agentdiag-[0-9a-f]{16}$/);
    expect(item!.title).toContain('claude');
    expect(item!.title).toContain('rate-limit');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('rate-limit');
    expect(item!.prompt).toContain('3 of 4 recorded in-window invocations');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('agent-logs');
    expect(item!.prompt).toContain('src/core/run/agent-diagnostics.ts');
  });

  it('emits nothing below the recurring bars of rows and days', async () => {
    const dir = join(home, 'agent-logs');
    // Three rows but all on one UTC day — under the day bar.
    await runFile(dir, refName(1), [
      fail('aider', NOW - 2 * HOUR, { errorClass: 'timeout' }),
      fail('aider', NOW - HOUR, { errorClass: 'timeout' }),
      fail('aider', NOW - 30 * MIN, { errorClass: 'timeout' }),
    ]);
    expect(await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) })).toEqual([]);

    // Two rows across two days — under the row bar.
    await runFile(dir, refName(2), [
      fail('codex', NOW - 2 * DAY, { errorClass: 'authentication' }),
      fail('codex', NOW - DAY, { errorClass: 'authentication' }),
    ]);
    expect(await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(AGENTDIAG_MIN_ROWS).toBe(3);
    expect(AGENTDIAG_MIN_DAYS).toBe(2);
  });

  it('surfaces stall verdicts and config-recovery as their own cells', async () => {
    const dir = join(home, 'agent-logs');
    await runFile(dir, refName(1), [
      fail('grok-cli', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'execution', terminationReason: 'idle-stall' }),
      fail('grok-cli', NOW - 2 * DAY - HOUR, { errorClass: 'none', terminationReason: 'idle-stall' }),
      fail('grok-cli', NOW - DAY - 3 * HOUR, { errorClass: 'execution', terminationReason: 'idle-stall' }),
      pass('grok-cli', NOW - 2 * DAY, { configRecoveryAttempts: 1 }),
      pass('grok-cli', NOW - DAY, { configRecoveryAttempts: 2 }),
      pass('grok-cli', NOW - DAY + HOUR, { configRecoveryAttempts: 1 }),
    ]);
    const items = await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    const stall = items.find((i) => i.title.includes('idle-stall'))!;
    const recovery = items.find((i) => i.title.includes('config recovery'))!;
    expect(stall).toBeDefined();
    expect(recovery).toBeDefined();
    expect(stall!.prompt).toContain('went quiet');
    expect(recovery!.prompt).toContain('4 total config-repair respawn(s)');
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it('folds rows across per-run files and ignores non-journal entries', async () => {
    const dir = join(home, 'agent-logs');
    await runFile(dir, refName(1), [
      fail('kimi', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'command-missing' }),
    ]);
    await runFile(dir, refName(2), [
      fail('kimi', NOW - 2 * DAY - HOUR, { errorClass: 'command-missing' }),
    ]);
    await runFile(dir, refName(3), [
      fail('kimi', NOW - DAY - 3 * HOUR, { errorClass: 'command-missing' }),
    ]);
    // Legacy .log, lock files and non-runRef .jsonl names are not folded.
    await writeFile(join(dir, 'run-abc123.log'), 'legacy\n');
    await writeFile(join(dir, `${refName(4)}.lock`), '{}');
    await writeFile(join(dir, 'not-a-runref.jsonl'), fail('kimi', NOW - DAY, { errorClass: 'command-missing' }));
    // A file whose mtime predates the window cannot hold in-window rows.
    await runFile(dir, refName(5), [
      fail('kimi', NOW - DAY, { errorClass: 'command-missing' }),
    ], NOW - AGENTDIAG_WINDOW_MS - DAY);
    const items = await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('command-missing');
    expect(items[0]!.prompt).toContain('3 recorded');
  });

  it('emits nothing for a missing directory, another repository, or empty evidence', async () => {
    expect(await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = join(home, 'agent-logs');
    await runFile(dir, refName(1), [
      fail('aider', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'unknown-signal' }),
      fail('aider', NOW - DAY, { errorClass: 'unknown-signal' }),
      fail('aider', NOW - DAY + HOUR, { errorClass: 'unknown-signal' }),
    ]);
    // Off-contract rows never form cells.
    expect(await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) })).toEqual([]);

    await runFile(dir, refName(2), [
      fail('aider', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'timeout' }),
      fail('aider', NOW - 2 * DAY - HOUR, { errorClass: 'timeout' }),
      fail('aider', NOW - DAY - 3 * HOUR, { errorClass: 'timeout' }),
    ]);
    expect(await agentDiagnosticsBacklogItems({ repo: 'ashlrai/other', logsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await agentDiagnosticsBacklogItems({ repo: 'AshlrAI/Phantom', logsDir: dir, now: new Date(NOW) })).toHaveLength(1);
    expect(await agentDiagnosticsBacklogItems({ repo: '', logsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('states an oversized file as a lower bound in the prompt', async () => {
    const dir = join(home, 'agent-logs');
    const pad = 'x'.repeat(140 * 1024);
    await runFile(dir, refName(1), [
      pad,
      fail('codex', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'terminated' }),
      fail('codex', NOW - 2 * DAY - HOUR, { errorClass: 'terminated' }),
      fail('codex', NOW - DAY - 3 * HOUR, { errorClass: 'terminated' }),
    ]);
    const items = await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('counts malformed lines in the coverage note', async () => {
    const dir = join(home, 'agent-logs');
    await runFile(dir, refName(1), [
      'garbage line',
      fail('aider', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'configuration' }),
      diag('aider', NOW - 2 * DAY - HOUR, { schemaVersion: 9 }),
      fail('aider', NOW - 2 * DAY - 30 * MIN, { errorClass: 'configuration' }),
      fail('aider', NOW - DAY - 3 * HOUR, { errorClass: 'configuration' }),
    ]);
    const items = await agentDiagnosticsBacklogItems({ repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('2 malformed or off-contract lines dropped');
    expect(items[0]!.prompt).toContain('configuration');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = join(home, 'agent-logs');
    await runFile(dir, refName(1), [
      fail('aider', NOW - 2 * DAY - 2 * HOUR, { errorClass: 'timeout' }),
      fail('aider', NOW - 2 * DAY - HOUR, { errorClass: 'timeout' }),
      fail('aider', NOW - DAY - 3 * HOUR, { errorClass: 'timeout' }),
      fail('claude', NOW - 2 * DAY - 3 * HOUR, { errorClass: 'rate-limit' }),
      fail('claude', NOW - 2 * DAY - 4 * HOUR, { errorClass: 'rate-limit' }),
      fail('claude', NOW - DAY - 4 * HOUR, { errorClass: 'rate-limit' }),
    ]);
    const opts = { repo: 'ashlrai/phantom', logsDir: dir, now: new Date(NOW) };
    const first = await agentDiagnosticsBacklogItems(opts);
    const second = await agentDiagnosticsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    expect(first.length).toBeLessThanOrEqual(AGENTDIAG_BACKLOG_MAX_ITEMS);
    expect(await agentDiagnosticsBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
    expect(AGENTDIAG_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('appends agentdiag items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors its window at the real clock, so rows are
    // stamped relative to Date.now() and files keep their real mtimes.
    // UTC noons two and one days back guarantee distinct UTC days at any
    // wall-clock time the suite runs.
    const d = new Date();
    const day2 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 2, 12);
    const day1 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 12);
    const dir = agentDiagnosticsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, refName(9)), [
      fail('aider', day2, { errorClass: 'rate-limit' }),
      fail('aider', day2 + HOUR, { errorClass: 'rate-limit' }),
      fail('aider', day1, { errorClass: 'rate-limit' }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const diagItems = first.items.filter((i) => i.id.startsWith('fleet-agentdiag-'));
    expect(diagItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(diagItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-agentdiag-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-agentdiag-'))).toHaveLength(1);
  });
});
