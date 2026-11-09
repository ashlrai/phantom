/**
 * `ashlr leader` — V3.10 Track B (unit U8). Registered by B-U1 in src/cli/index.ts.
 *
 *   ashlr leader show [--json]               the latest memo, actions, hit-rate
 *   ashlr leader run [--force]               run the Leader now (waits for the memo)
 *   ashlr leader tick [--wait]               apply due class-B actions, grade moves,
 *                                            and start a run if one is due
 *   ashlr leader veto <actionId> [--note T]  undo one action
 *   ashlr leader veto --memo <memoId> [--note T]   undo a whole memo
 *   ashlr leader oversight-plist --print [--bin P]  print (never install) the
 *                                            nightly ai.ashlr.oversight plist
 *
 * 3.14 — talk to the Leader (vision/leader-thread.ts; the same thread Verse
 * and Telegram use):
 *   ashlr leader say "<text>"                 say something; prints the reply
 *   ashlr leader thread [--limit n] [--json]  the conversation, oldest first
 *   ashlr leader answer <questionId> "<text>" answer one of the memo's questions
 *   ashlr leader approve <actionId>           approve a pending action (class B
 *                                            applies now only if the grant
 *                                            still allows it; dry run / class C
 *                                            are recorded, never applied)
 *   ashlr leader directives [list] [--all] [--json]
 *   ashlr leader directives add "<text>" [--kind focus|stop|priority|guidance]
 *   ashlr leader directives retire <directiveId>
 *
 * `run` spends at most one Leader call on a seat the router allows (with no
 * standing grant: a free local model or nothing). `veto` only lowers what
 * autonomy is doing. Exit codes: 0 success, 1 error / refused, 2 bad usage.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { leaderAsk, leaderAssign, leaderOrg, leaderStatus } from '../core/agents/leader-office.js';
import { loadConfig } from '../core/config.js';
import { hasLeaderNetworkConfig } from '../core/agents/leader-network-config.js';
import { rejectUnknownOptions, type AllowedOptions } from './args.js';
import type { LeaderAction, LeaderMemo, LeaderStateV1 } from '../core/vision/leader-types.js';

const USAGE = `Phantom Leader — memo, actions and veto

Compatible alias: ashlr leader <command>

Usage:
  phm leader show [--json]
  phm leader status [--json]
  phm leader ask "<text>" [--json]
  phm leader org [--json]
  phm leader assign --rq <RQ-KEY> --owner <role> --summary "<text>" [--due YYYY-MM-DD] [--status assigned|in_progress|blocked|done|proposed] [--outcome "<text>"] [--json]
  phm leader seat [--json] [--tier elite|workhorse|fast|local]
  phm leader inbox [--json] [--limit n] [--text "message"]
  phm leader run [--force]
  phm leader tick [--wait]
  phm leader veto <actionId> [--note "why"]
  phm leader veto --memo <memoId> [--note "why"]
  phm leader oversight-plist --print [--bin /path/to/phm]
  phm leader say "<text>"
  phm leader replies [--json] [--limit n]  show recent PLAN-LOG replies, newest first
  phm leader replies sync [--json]  copy new PLAN-LOG replies to the Leader thread
  phm leader thread [--limit n] [--follow] [--since messageId] [--json]
  phm leader answer <questionId> "<text>"
  phm leader approve <actionId>
  phm leader directives [list] [--all] [--json]
  phm leader directives add "<text>" [--kind focus|stop|priority|guidance]
  phm leader directives retire <directiveId>`;

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  args.splice(i, 2);
  return value;
}

function line(action: LeaderAction): string {
  const when = action.status === 'scheduled' && action.applyAfter ? ` (applies ${action.applyAfter})` : '';
  const reason = action.statusReason ? ` — ${action.statusReason}` : '';
  return `  [${action.class}] ${action.status.padEnd(9)} ${action.id}  ${action.summary}${when}${reason}`;
}

function printMemo(memo: LeaderMemo | null): void {
  if (!memo) {
    console.log('No memo yet.');
    return;
  }
  console.log(`Memo ${memo.id} — ${memo.at} — ${memo.status}${memo.dryRun ? ' (dry run)' : ''}`);
  if (memo.seatId) console.log(`  seat: ${memo.seatId} (${memo.model ?? 'unknown model'})`);
  if (memo.statusReason) console.log(`  note: ${memo.statusReason}`);
  if (memo.bottleneck) console.log(`\nTHE BOTTLENECK: ${memo.bottleneck.statement}`);
  if (memo.move) {
    const d = memo.move.expectedDelta;
    console.log(`THE MOVE: ${memo.move.statement}${d ? `  (${d.metric} ${d.delta >= 0 ? '+' : ''}${d.delta} by ${d.byDate.slice(0, 10)})` : ''}`);
  }
  if (memo.killList.length > 0) {
    console.log('\nKill list:');
    for (const k of memo.killList) console.log(`  - ${k.target.kind} ${k.target.id}: ${k.why}`);
  }
  if (memo.questionsForMason.length > 0) {
    console.log('\nQuestions for you:');
    for (const q of memo.questionsForMason) console.log(`  - ${q}`);
  }
  if (memo.actions.length > 0) {
    console.log('\nActions:');
    for (const a of memo.actions) console.log(line(a));
  }
}

function printState(state: LeaderStateV1): void {
  printMemo(state.latest);
  const hr = state.hitRate;
  console.log(`\nHit-rate (${hr.windowDays} d): ${hr.rate === null ? 'not graded yet' : `${Math.round(hr.rate * 100)}% of ${hr.graded}`}`);
  const runsToday = state.dailyRunCounts
    ? state.dailyRunCounts.total === null ? 'unknown (incomplete history)' : state.dailyRunCounts.total
    : state.runsToday;
  console.log(`Runs today: ${runsToday}; next scheduled run: ${state.nextRunAt ?? 'unknown'}`);
  if (state.lastRun) console.log(`Last run: ${state.lastRun.at} — ${state.lastRun.outcome}${state.lastRun.reason ? ` (${state.lastRun.reason})` : ''}`);
  const health = state.health;
  if (health) {
    console.log(`Leader: ${health.status} — ${health.summary}`);
    if (health.nextDueAt) console.log(`Next due: ${health.nextDueAt} (${health.nextDueReason ?? ''})`);
    for (const a of health.seats) {
      console.log(`  seat ${a.seatId} [${a.outcome}]${a.ms !== null ? ` ${Math.round(a.ms / 1000)} s` : ''}${a.reason ? ` — ${a.reason}` : ''}`);
    }
  }
  const live = state.actions.filter((a) => a.status === 'scheduled');
  if (live.length > 0) {
    console.log('\nWaiting on their veto window:');
    for (const a of live) console.log(line(a));
  }
}

// ---------------------------------------------------------------------------
// Wake (3.14): let the comms poller start a tick when a time-based run is due
// ---------------------------------------------------------------------------

/** Minimum gap between two background ticks started by the poller. */
export const LEADER_WAKE_THROTTLE_MS = 10 * 60_000;

export interface LeaderWakeDeps {
  now(): number;
  /** Start `ashlr leader tick --wait` detached; false when it could not be started. */
  spawnTick(): boolean;
  readLastWake(): number;
  writeLastWake(ms: number): void;
}

function wakeStampPath(root: string): string {
  return join(root, '.wake.json');
}

async function defaultWakeDeps(): Promise<LeaderWakeDeps> {
  const { leaderRoot } = await import('../core/vision/leader-memo.js');
  const root = leaderRoot();
  return {
    now: () => Date.now(),
    spawnTick: () => {
      // The same node + ashlr entry point this process runs under (launchd
      // gives absolute paths); never a PATH lookup.
      const entry = process.argv[1];
      // Never from a test runner: argv[1] would be the runner, not ashlr (and a
      // stray child could touch real state — see the 2026 poisoned-daemon incident).
      if (process.env['VITEST']) return false;
      if (!entry || !isAbsolute(entry) || !existsSync(entry)) return false;
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(join(root, '.wake-result.json'), JSON.stringify({ at: new Date().toISOString(), status: 'started', code: null }), { mode: 0o600 });
        // The child records its own outcome, including failures, after this poller exits.
        const child = spawn(process.execPath, [entry, 'leader', 'tick', '--wait'], { detached: true, stdio: 'ignore', env: process.env });
        child.on('error', () => {
          try { writeFileSync(join(root, '.wake-result.json'), JSON.stringify({ at: new Date().toISOString(), status: 'spawn-failed', code: null }), { mode: 0o600 }); } catch { /* next health read sees started */ }
        });
        child.unref();
        return true;
      } catch {
        return false;
      }
    },
    readLastWake: () => {
      try {
        const parsed = JSON.parse(readFileSync(wakeStampPath(root), 'utf8')) as { at?: unknown };
        return typeof parsed.at === 'number' ? parsed.at : 0;
      } catch {
        return 0;
      }
    },
    writeLastWake: (ms) => {
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(wakeStampPath(root), JSON.stringify({ at: ms }), { mode: 0o600 });
      } catch { /* a missed stamp only means an extra (lock-guarded) tick */ }
    },
  };
}

/**
 * Called from `ashlr comms cycle` (every 3 minutes under ai.ashlr.comms-poll),
 * so retries and working-hours check-ins happen without the daemon. Cheap:
 * reads the Leader state file only, and starts a background tick at most
 * every 10 minutes, only when a time-based run could be due. The tick runs
 * under the Leader's run lock, so an overlap exits at once. Never throws.
 */
export async function wakeLeaderIfDue(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  deps?: LeaderWakeDeps,
): Promise<{ started: boolean; why: string }> {
  try {
    const d = deps ?? await defaultWakeDeps();
    const nowMs = d.now();
    if (nowMs - d.readLastWake() < LEADER_WAKE_THROTTLE_MS) return { started: false, why: 'woke the Leader recently' };
    const [leader, cadenceMod] = await Promise.all([import('../core/vision/leader.js'), import('../core/vision/leader-cadence.js')]);
    const wake = leader.leaderWakeDue(nowMs, leader.readLeaderRunState(), cadenceMod.resolveLeaderCadence(cfg));
    const networkPending = hasLeaderNetworkConfig() && await (await import('../core/agents/leader-network-runtime.js')).hasPendingLeaderNetwork();
    if (!wake.due && !networkPending) return { started: false, why: wake.why };
    d.writeLastWake(nowMs);
    return d.spawnTick() ? { started: true, why: networkPending ? 'verified Leader inbox request' : wake.why } : { started: false, why: 'the tick could not be started' };
  } catch {
    return { started: false, why: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Nightly oversight plist (printed, never installed)
// ---------------------------------------------------------------------------

export interface OversightPlistOptions {
  home: string;
  /** Absolute path of the `ashlr` launcher the job runs. */
  ashlrBin: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The zsh body ai.ashlr.oversight runs. WHY each line:
 *  - `leader tick --wait` replaces `ashlr vision review` (legacy Strategist,
 *    Claude CLI first with no budget gate). A run starts only when one is
 *    due, on a seat the router admits; the 07:00 slot catches the 06:30
 *    cadence when the daemon is dark, and is a cheap no-op when it already ran.
 *  - `fleet oversight` is a read-only snapshot (no model). `comms digest` is
 *    change-driven (3.14): it speaks only when merges / PRs / reverts / seats /
 *    cloud tasks changed, or once per idle stretch; otherwise it is silent.
 *  - `comms ask-vision` queues the newest memo as a non-blocking message; its
 *    own tick finds nothing due right after the one above, so it never pays
 *    for a second run.
 *  - `ashlr manager` is deliberately NOT here: its judge resolves the Claude
 *    CLI outside the SeatRouter, so it would spend the reserve unattended.
 */
export function oversightScript(ashlrBin: string): string {
  const bin = shellQuote(ashlrBin);
  return [
    'LOG="$HOME/.ashlr/oversight.log"',
    '{',
    '  echo "=== oversight run $(date) ==="',
    `  ${bin} leader tick --wait`,
    `  ${bin} fleet oversight`,
    '  echo "=== oversight done $(date) ==="',
    `  ${bin} comms digest`,
    `  ${bin} comms ask-vision`,
    '} >> "$LOG" 2>&1',
  ].join('\n');
}

/**
 * PURE: the ai.ashlr.oversight LaunchAgent, self-contained (the script is
 * inline, so nothing depends on an unreviewed ~/.ashlr/oversight.sh). Same
 * label, 07:00 schedule and log paths as the plist it replaces, so swapping it
 * in is a like-for-like `launchctl bootout` + `bootstrap` Mason runs himself.
 * (The XML comment must never contain "--", which XML forbids in comments.)
 */
export function buildOversightPlist(opts: OversightPlistOptions): string {
  const home = xmlEscape(opts.home);
  const pathEnv = xmlEscape(`${opts.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Printed by ashlr leader oversight-plist. Review, then install by hand: docs/AUTHORITY.md, Nightly oversight. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>ai.ashlr.oversight</string>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${home}</string>
\t\t<key>PATH</key>
\t\t<string>${pathEnv}</string>
\t</dict>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/zsh</string>
\t\t<string>-c</string>
\t\t<string>${xmlEscape(oversightScript(opts.ashlrBin))}</string>
\t</array>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Hour</key>
\t\t<integer>7</integer>
\t\t<key>Minute</key>
\t\t<integer>0</integer>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${home}/.ashlr/oversight.launchd.out.log</string>
\t<key>StandardErrorPath</key>
\t<string>${home}/.ashlr/oversight.launchd.err.log</string>
</dict>
</plist>
`;
}

async function runOversightPlist(args: string[]): Promise<number> {
  const print = flag(args, '--print');
  const binOpt = option(args, '--bin');
  // --print is required so nobody mistakes this for an installer: it writes
  // nothing and never calls launchctl (activation is Mason's step).
  if (!print || binOpt === undefined || args.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const { homedir } = await import('node:os');
  const { isAbsolute, join } = await import('node:path');
  const home = process.env['HOME'] || homedir();
  // Default: the stable ~/.local/bin/ashlr symlink the installer maintains,
  // so a new release is picked up without regenerating the plist.
  const ashlrBin = binOpt ?? join(home, '.local', 'bin', 'ashlr');
  if (!isAbsolute(ashlrBin)) {
    console.error('oversight-plist: --bin must be an absolute path (launchd has no shell PATH lookup you can rely on).');
    return 2;
  }
  process.stdout.write(buildOversightPlist({ home, ashlrBin }));
  return 0;
}

// ---------------------------------------------------------------------------
// The thread (3.14)
// ---------------------------------------------------------------------------

type ThreadModule = typeof import('../core/vision/leader-thread.js');

function printThreadMessage(m: import('../core/vision/leader-thread.js').LeaderThreadMessage): void {
  const who = m.from === 'mason' ? 'You' : 'Leader';
  const tag = m.kind === 'message' ? '' : ` [${m.kind}${m.questionId ? ` ${m.questionId}` : ''}]`;
  console.log(`${m.at.slice(0, 16).replace('T', ' ')} ${who} (${m.channel})${tag} ${m.id}`);
  for (const l of m.text.split('\n')) console.log(`  ${l}`);
}

/** Thread errors are the caller's (bad id, empty text): exit 1 with the reason, never a stack. */
async function threadCall(thread: ThreadModule, fn: () => Promise<number> | number): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof thread.LeaderThreadError) {
      console.error(err.message);
      return err.code === 400 ? 2 : 1;
    }
    throw err;
  }
}

/**
 * Free-text verbs (`say`, `answer`, `directives add`) used to glue a stray or
 * mistyped flag into the text and send or record it. Refuse any option the verb
 * does not read unless it follows a `--` separator. Removes the separator and
 * everything after it from `args` and returns those trailing text tokens, or
 * null (after printing the refusal) when an option is refused.
 */
function takeTextArgs(args: string[], allowed: AllowedOptions): string[] | null {
  const bad = rejectUnknownOptions(args, allowed);
  if (bad) {
    console.error(bad.message);
    console.error(USAGE);
    return null;
  }
  const separator = args.indexOf('--');
  return separator === -1 ? [] : args.splice(separator).slice(1);
}

async function runThreadCli(sub: string, args: string[]): Promise<number> {
  if (sub === 'say' || sub === 'answer') {
    const tail = takeTextArgs(args, {});
    if (!tail) return 2;
    args.push(...tail);
  }
  const thread = await import('../core/vision/leader-thread.js');
  if (sub === 'say') {
    const text = args.join(' ').trim();
    if (text.length === 0) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, async () => {
      const result = await thread.appendMasonMessage(text, { channel: 'cli', cfg: loadConfig() });
      if (result.directive) console.log(`Standing directive recorded: ${result.directive.id} (${result.directive.kind}) ${result.directive.text}`);
      if (result.reply) console.log(result.reply.text);
      return 0;
    });
  }
  if (sub === 'thread') {
    const json = flag(args, '--json');
    const limitOpt = option(args, '--limit');
    const follow = flag(args, '--follow');
    const sinceId = option(args, '--since');
    if (limitOpt === undefined || sinceId === undefined || (sinceId !== null && !follow) || args.length > 0 || (limitOpt !== null && !/^\d{1,3}$/.test(limitOpt))) {
      console.error(USAGE);
      return 2;
    }
    if (follow) {
      const { followThread } = await import('../core/vision/leader-thread-follow.js');
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      try {
        await followThread({
          list: thread.listThread, signal: controller.signal,
          ...(limitOpt === null ? {} : { backlog: Number(limitOpt) }),
          ...(sinceId === null ? {} : { sinceId }),
          onMessage: m => { if (json) console.log(JSON.stringify(m)); else printThreadMessage(m); },
          onError: error => console.error(error instanceof Error ? error.message : String(error)),
        });
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      return 0;
    }
    return threadCall(thread, async () => {
      const messages = await thread.listLeaderThread(limitOpt === null ? {} : { limit: Number(limitOpt) });
      if (json) console.log(JSON.stringify({ messages }, null, 2));
      else if (messages.length === 0) console.log('No messages yet. Say something: phm leader say "…"');
      else for (const m of messages) printThreadMessage(m);
      return 0;
    });
  }
  if (sub === 'answer') {
    const questionId = args.shift();
    const text = args.join(' ').trim();
    if (!questionId || text.length === 0) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, async () => {
      const result = await thread.answerLeaderQuestion(questionId, text, { channel: 'cli', cfg: loadConfig() });
      console.log(`Answer recorded for ${questionId}.`);
      if (result.reply) console.log(result.reply.text);
      return 0;
    });
  }
  if (sub === 'approve') {
    const actionId = args.shift();
    if (!actionId || args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, async () => {
      const result = await thread.approveLeaderAction(actionId, { channel: 'cli', cfg: loadConfig() });
      console.log(result.message);
      return result.ok ? 0 : 1;
    });
  }
  return runDirectivesCli(args);
}

async function runDirectivesCli(args: string[]): Promise<number> {
  const operator = await import('../core/vision/leader-operator.js');
  const action = args[0] && !args[0].startsWith('--') ? args.shift()! : 'list';
  if (action === 'list') {
    const all = flag(args, '--all');
    const json = flag(args, '--json');
    if (args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const directives = operator.listOperatorDirectives({ includeRetired: all });
    if (json) console.log(JSON.stringify({ directives }, null, 2));
    else if (directives.length === 0) console.log('No standing directives. Add one: phm leader directives add "focus on …"');
    else for (const d of directives) console.log(`  ${d.id} [${d.kind}]${d.retiredAt ? ` (retired ${d.retiredAt.slice(0, 10)})` : ''} ${d.text}`);
    return 0;
  }
  if (action === 'add') {
    const tail = takeTextArgs(args, { values: ['--kind'] });
    if (!tail) return 2;
    const kindOpt = option(args, '--kind');
    const text = [...args, ...tail].join(' ').trim();
    if (kindOpt === undefined || text.length === 0 || (kindOpt !== null && !operator.isOperatorDirectiveKind(kindOpt))) {
      console.error(USAGE);
      return 2;
    }
    const result = operator.addOperatorDirective({ kind: (kindOpt ?? 'guidance') as import('../core/vision/leader-operator.js').OperatorDirectiveKind, text, source: 'direct', channel: 'cli' });
    if (!result.ok) {
      console.error(result.reason);
      return result.code === 400 ? 2 : 1;
    }
    console.log(`${result.duplicate ? 'Already in force' : 'Recorded'}: ${result.directive.id} [${result.directive.kind}] ${result.directive.text}`);
    return 0;
  }
  if (action === 'retire') {
    const id = args.shift();
    if (!id || args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const result = operator.retireOperatorDirective(id, 'cli');
    if (!result.ok) {
      console.error(result.reason);
      return result.code === 400 ? 2 : 1;
    }
    console.log(`Retired: ${result.directive.id} ${result.directive.text}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

const ASSIGNMENT_STATUSES = ['assigned', 'in_progress', 'blocked', 'done', 'proposed'] as const;

function officeCode(status: string): number {
  return status === 'stopped' || status === 'refused' || status === 'unavailable' ? 1 : 0;
}

function printOffice(json: boolean, value: unknown): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (!value || typeof value !== 'object') {
    console.log(JSON.stringify(value));
    return;
  }
  if ('priorities' in value && 'killed' in value) {
    const view = value as { killed: boolean; priorities: { rq: string; owner: string; status: string; due: string | null }[] };
    console.log(`killed: ${view.killed}`);
    if (view.priorities.length === 0) console.log('No open work.');
    else for (const row of view.priorities) console.log(`${row.rq}  ${row.owner}  ${row.status}${row.due ? `  due ${row.due}` : ''}`);
    return;
  }
  if ('reply' in value && 'status' in value) {
    const decision = value as { status: string; reply?: { text?: string } | null };
    console.log(decision.reply?.text ? `${decision.status}: ${decision.reply.text}` : decision.status);
    return;
  }
  if ('org' in value) {
    const roles = (value as { org: { roles: { id: string; title: string; owner: string; lane: string }[] } }).org.roles;
    console.log(roles.map((role) => `${role.id}  ${role.title}  ${role.owner}  ${role.lane}`).join('\n'));
    return;
  }
  console.log(JSON.stringify(value));
}

/** Org, accountability and owner inbox. Reads the world on status, ask and assign. Does not call a model. */
async function runOfficeCli(sub: 'status' | 'ask' | 'org' | 'assign', args: string[]): Promise<number> {
  const json = flag(args, '--json');
  if (sub === 'status' || sub === 'org') {
    if (args.length > 0) { console.error(USAGE); return 2; }
    const result = sub === 'status' ? await leaderStatus() : leaderOrg();
    const failed = 'status' in result && !('killed' in result);
    printOffice(json, result);
    return failed ? officeCode(String(result.status)) : 0;
  }
  if (sub === 'ask') {
    const textOption = option(args, '--text');
    if (textOption === undefined || (textOption !== null && args.length > 0)) { console.error(USAGE); return 2; }
    const text = (textOption ?? args.join(' ')).trim();
    if (!text) { console.error(USAGE); return 2; }
    const result = await leaderAsk({ text });
    printOffice(json, result);
    return officeCode(result.status);
  }
  const rq = option(args, '--rq');
  const owner = option(args, '--owner');
  const summary = option(args, '--summary');
  const due = option(args, '--due');
  const status = option(args, '--status');
  const outcome = option(args, '--outcome');
  const dueValue = due ?? null;
  const statusValue = status ?? null;
  const outcomeValue = outcome ?? null;
  if ([rq, owner, summary, due, status, outcome].some((value) => value === undefined) || args.length > 0
    || !rq || !owner || !summary || (statusValue !== null && !(ASSIGNMENT_STATUSES as readonly string[]).includes(statusValue))) {
    console.error(USAGE);
    return 2;
  }
  const result = await leaderAssign({ rq, owner, summary, due: dueValue, status: statusValue, outcome: outcomeValue });
  printOffice(json, result);
  return officeCode(result.status);
}

/** Typed CEO inspection and compose verbs; inspection never calls a model. */
async function runCeoCli(sub: 'seat' | 'inbox', args: string[]): Promise<number> {
  const json = flag(args, '--json');
  const limit = option(args, '--limit');
  const text = option(args, '--text');
  const tier = option(args, '--tier');
  if (args.length || limit === undefined || text === undefined || tier === undefined ||
      (sub === 'seat' && (limit !== null || text !== null)) ||
      (sub === 'inbox' && tier !== null) ||
      (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) ||
      (tier !== null && !['elite', 'workhorse', 'fast', 'local'].includes(tier))) {
    console.error(USAGE); return 2;
  }
  try {
    if (sub === 'seat') {
      const { loadDefaultLeaderSeatDeps, inspectLeaderSeats } = await import('../core/vision/leader-seat.js');
      const cfg = loadConfig();
      if (tier !== null) {
        const foundry = (cfg.foundry ?? {}) as Record<string, unknown>;
        const current = foundry.leader as Record<string, unknown> | undefined;
        cfg.foundry = { ...foundry, leader: { ...current, modelTiers: current?.modelTiers ?? {}, taskTier: { ...(current?.taskTier as Record<string, unknown> | undefined), full: tier } } } as typeof cfg.foundry;
      }
      const result = await inspectLeaderSeats(await loadDefaultLeaderSeatDeps(cfg), { deep: false, promptChars: 0, mode: 'full' });
      console.log(json ? JSON.stringify(result, null, 2) : result.seats.map(seat => `${seat.seatId}  ${seat.model}  ${seat.tier ?? 'unclassified'}`).join('\n') || result.reason);
      return 0;
    }
    const { readLeaderInbox, composeLeaderInbox } = await import('../core/agents/leader-network-runtime.js');
    if (text !== null) {
      const result = await composeLeaderInbox(text);
      console.log(json ? JSON.stringify(result) : result.ok ? 'Recorded for the Leader.' : result.reason);
      return result.ok ? 0 : 1;
    }
    const result = await readLeaderInbox({ limit: limit === null ? 30 : Number(limit) });
    console.log(json ? JSON.stringify(result, null, 2) : result.inbox.entries.map(entry => `${entry.at} ${entry.text}`).join('\n') || 'No inbox entries yet.');
    return 0;
  } catch {
    console.error(json ? JSON.stringify({ error: 'leader-unavailable' }) : 'Leader state is unavailable.');
    return 1;
  }
}

export async function runLeaderCli(argv: string[]): Promise<number> {
  const args = [...argv];
  const sub = args.shift();
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  // `leader <verb> --help` prints usage and never runs the verb: without this,
  // `leader directives add --help` recorded a standing directive "--help" and
  // `leader say --help` posted "--help" to the thread.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  // Before the core import: printing a plist needs no Leader state.
  if (sub === 'replies') {
    const json = flag(args, '--json');
    const sync = args[0] === 'sync';
    if (sync) args.shift();
    const limit = option(args, '--limit');
    if (args.length || limit === undefined || (sync && limit !== null) || (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200))) { console.error(USAGE); return 2; }
    try {
      if (!sync) {
        const { readPlanLogReplies } = await import('../core/fleet/mason-outbox.js');
        const result = await readPlanLogReplies({ limit: limit === null ? 30 : Number(limit) });
        result.entries.reverse();
        console.log(json ? JSON.stringify(result) : result.entries.map(entry => `${entry.at}  ${entry.text}`).join('\n\n') || 'No replies yet.');
        return result.sourceState === 'unknown' ? 1 : 0;
      }
      const { syncLeaderReplies } = await import('../core/vision/leader-thread.js');
      const result = await syncLeaderReplies();
      console.log(json ? JSON.stringify(result) : `${result.posted.length} replies posted; ${result.skipped.length} skipped. Source: ${result.sourceState}. Uncertain: ${result.unknown.length}.`);
      return result.sourceState === 'unknown' || result.unknown.length ? 1 : 0;
    } catch {
      console.error(json ? JSON.stringify({ error: 'leader-replies-unavailable' }) : 'Leader replies are unavailable.');
      return 1;
    }
  }
  if (sub === 'oversight-plist') return runOversightPlist(args);
  if (sub === 'status' || sub === 'ask' || sub === 'org' || sub === 'assign') return runOfficeCli(sub, args);
  if (sub === 'seat' || sub === 'inbox') return runCeoCli(sub, args);
  if (sub === 'say' || sub === 'thread' || sub === 'answer' || sub === 'approve' || sub === 'directives') return runThreadCli(sub, args);
  const leader = await import('../core/vision/leader.js');

  if (sub === 'show') {
    const json = flag(args, '--json');
    if (args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const state = leader.buildLeaderState(Date.now());
    if (json) console.log(JSON.stringify(state, null, 2));
    else printState(state);
    return 0;
  }

  if (sub === 'run' || sub === 'tick') {
    const force = sub === 'run' && flag(args, '--force');
    const wait = sub === 'tick' && flag(args, '--wait');
    if (args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const recordTick = async (status: 'completed' | 'failed', code: number): Promise<void> => {
      const { leaderRoot } = await import('../core/vision/leader-memo.js');
      mkdirSync(leaderRoot(), { recursive: true, mode: 0o700 });
      writeFileSync(join(leaderRoot(), '.wake-result.json'), JSON.stringify({ at: new Date().toISOString(), status, code }), { mode: 0o600 });
    };
    try {
      const deps = await leader.loadDefaultLeaderRunDeps(loadConfig());
      if (sub === 'run') {
        console.log('Running the Leader (a local model can take several minutes)…');
        const result = await leader.runLeader(deps, 'manual', { force });
        if (!result.memo) {
          console.log(`${result.outcome}: ${result.reason ?? ''}`);
          return result.outcome === 'skipped-unchanged' ? 0 : 1;
        }
        printMemo(result.memo);
        return result.outcome === 'ok' ? 0 : 1;
      }
      const tick = await leader.leaderTick(deps, { awaitRun: wait });
      console.log(`Applied ${tick.applied.length} due action(s); graded ${tick.graded.length} move(s).`);
      console.log(tick.due.due ? `Run due (${tick.due.trigger}): ${tick.due.reason}${tick.started ? ' - started.' : ''}` : `No run due: ${tick.due.reason}`);
      if (tick.run?.memo) printMemo(tick.run.memo);
      if (tick.run && !['ok', 'skipped-unchanged'].includes(tick.run.outcome)) {
        await recordTick('failed', 1);
        console.error('Leader tick failed to produce a successful run. Check Leader health and model availability.');
        return 1;
      }
      await recordTick('completed', 0);
      return 0;
    } catch {
      if (sub === 'tick') await recordTick('failed', 1);
      console.error('Leader run failed. Check Leader health and model availability.');
      return 1;
    }
  }

  if (sub === 'veto') {
    const noteOpt = option(args, '--note');
    const memoOpt = option(args, '--memo');
    if (noteOpt === undefined || memoOpt === undefined) {
      console.error(USAGE);
      return 2;
    }
    const target = memoOpt ?? args.shift() ?? null;
    if (!target || args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const apply = await import('../core/vision/leader-apply.js');
    const deps = await apply.loadDefaultLeaderDeps();
    const result = memoOpt
      ? await apply.vetoLeaderMemo(deps, target, noteOpt)
      : await apply.vetoLeaderAction(deps, target, noteOpt);
    console.log(result.message);
    for (const r of result.records) console.log(`  ${r.actionId}: ${r.restored ? 'restored exactly' : 'not exact'} — ${r.detail}`);
    return result.ok ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}
