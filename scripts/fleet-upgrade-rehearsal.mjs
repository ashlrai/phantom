#!/usr/bin/env node

/**
 * fleet-upgrade-rehearsal.mjs — cold-start rehearsal for the one-jump fleet
 * upgrade (installed v3.29.15 -> master, ~1600 commits).
 *
 * Seeds a TEMPORARY home directory with state in the shapes v3.29.15 really
 * wrote (~/.ashlr/config.json, ~/.ashlr/daemon.json, ~/.ashlr/fleet/fleet.json
 * plus the bridge-owned ~/.ashlr-runs files the new verbs read), then runs a
 * fixed verb list against the CLI built from this worktree, each with a 30s
 * timeout. Per verb it reports exit code, duration and whether stderr held a
 * stack trace.
 *
 *   node scripts/fleet-upgrade-rehearsal.mjs --home <abs temp dir> [--json]
 *
 * Exit 0 when every verb completed inside its documented contract and every
 * seeded state file was readable; nonzero otherwise.
 *
 * HERMETIC BOUNDS: only fake values are seeded; the child env is a whitelist
 * (no credential, token, keychain or provider variables); the fixture config
 * restricts foundry.allowedBackends to 'builtin' so `resources` performs no
 * probe calls. The script itself makes no network calls and never reads the
 * real HOME — `--home` equal to the real home directory is refused.
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_CLI = join(REPO_ROOT, 'bin', 'ashlr');
const BUILT_CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

export const FLEET_REHEARSAL_TIMEOUT_MS = 30_000;

/**
 * The fixed first-start verb list. `okExits` is the verb's documented
 * contract: `local-runtime status` deliberately exits 1 when the runtime is
 * not up (unchanged since v3.29.15), which is a verdict, not a crash. Every
 * other verb exits 0 on success; any other code, a signal, a timeout or a
 * stack trace on stderr is a crash.
 */
export const FLEET_REHEARSAL_VERBS = Object.freeze([
  Object.freeze({ name: '--version', argv: Object.freeze(['--version']), okExits: Object.freeze([0]) }),
  Object.freeze({ name: 'fleet status --json', argv: Object.freeze(['fleet', 'status', '--json']), okExits: Object.freeze([0]) }),
  Object.freeze({ name: 'fleet brains --json', argv: Object.freeze(['fleet', 'brains', '--json']), okExits: Object.freeze([0]) }),
  Object.freeze({ name: 'fleet memory --json', argv: Object.freeze(['fleet', 'memory', '--json']), okExits: Object.freeze([0]) }),
  Object.freeze({ name: 'resources --json', argv: Object.freeze(['resources', '--json']), okExits: Object.freeze([0]) }),
  Object.freeze({ name: 'local-runtime status', argv: Object.freeze(['local-runtime', 'status']), okExits: Object.freeze([0, 1]) }),
]);

function fail(message) {
  throw new Error(`fleet-upgrade-rehearsal: ${message}`);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseRehearsalArgs(argv) {
  const options = { home: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home' && options.home === undefined) {
      const value = argv[++i];
      if (!value || value.startsWith('-')) fail('--home needs a directory');
      options.home = value;
    } else if (arg === '--json' && !options.json) {
      options.json = true;
    } else if ((arg === '--help' || arg === '-h') && !options.help) {
      options.help = true;
    } else {
      fail(`invalid argument ${arg}; usage: fleet-upgrade-rehearsal.mjs --home <dir> [--json]`);
    }
  }
  if (options.help) return options;
  if (!options.home) fail('usage: fleet-upgrade-rehearsal.mjs --home <dir> [--json]');
  if (!isAbsolute(options.home)) fail('--home must be an absolute path');
  const home = resolve(options.home);
  const realHome = homedir();
  if (home === realHome || home === resolve(realHome)) {
    fail('--home must never be the real home directory');
  }
  if (home === REPO_ROOT || home.startsWith(REPO_ROOT + sep)) {
    fail('--home must not be inside this worktree');
  }
  return { ...options, home };
}

// ---------------------------------------------------------------------------
// Fixture seeding — v3.29.15 shapes only (verified via `git show v3.29.15:`).
// Every value is fake.
// ---------------------------------------------------------------------------

const OLD_STAMP = '2026-10-14T06:30:00.000Z'; // the day the 3.29.15 tag shipped

/** v3.29.15 `firstRunConfig()` — its defaultConfig() shape with fake roots. */
function oldConfigDocument(home) {
  return {
    version: 1,
    roots: [join(home, 'code')],
    editor: 'cursor',
    staleDays: 30,
    categories: { rehearsal: join(home, 'code', 'rehearsal') },
    tidyRules: [
      {
        match: 'Screenshot*',
        matchType: 'glob',
        dest: join(home, 'Assets', 'Screenshots'),
        description: 'macOS screenshot files captured to Desktop',
      },
    ],
    keepers: ['rehearsal-keep'],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['lmstudio', 'ollama', 'anthropic'],
    },
    telemetry: {},
    tools: {},
    plugins: { enabled: [], settings: {}, integrity: {} },
    // The tag's defaultConfig() documents this block; 'builtin' alone keeps
    // `resources` from performing any provider or loopback probe.
    foundry: { allowedBackends: ['builtin'] },
    user: { id: 'rehearsal@example.invalid', name: 'Rehearsal Fixture' },
    daemon: { dailyBudgetUsd: 25, perTickItems: 3, parallel: 2, intervalMs: 900_000, mode: 'batch' },
  };
}

/**
 * v3.29.15 `freshDaemonState()` fields plus a realistic post-run tail: the
 * daemon was mid-service when the old version stopped, so its recorded pid
 * (424243 — above macOS PID_MAX, deterministically dead) must reconcile to
 * stopped on first read.
 */
function oldDaemonDocument() {
  return {
    running: true,
    pid: 424243,
    startedAt: '2026-10-14T06:00:00.000Z',
    lastTickAt: OLD_STAMP,
    todayDate: '2026-10-14',
    todaySpentUsd: 3.17,
    itemsProcessed: 41,
    automaticDrainOrdinaryTurnDue: false,
    ticks: [
      {
        ts: '2026-10-14T06:12:11.000Z', itemsConsidered: 3, proposalsCreated: 1,
        spentUsd: 0.41, reason: 'dispatched', directionMode: 'backlog-build',
        directionReason: '2 backlog item(s) are available', durationMs: 4120,
        backlogSnapshotAt: '2026-10-14T06:12:00.000Z', backlogSnapshotId: 'rq-rehearsal-snap-1',
        producerMaintenance: false,
      },
      {
        ts: OLD_STAMP, itemsConsidered: 2, proposalsCreated: 0,
        spentUsd: 0, reason: 'no-backlog', directionMode: 'backlog-build',
        directionReason: '0 backlog item(s) are available', durationMs: 980,
        backlogSnapshotAt: '2026-10-14T06:30:00.000Z', backlogSnapshotId: 'rq-rehearsal-snap-2',
        producerMaintenance: false,
      },
    ],
  };
}

/**
 * The shared fleet inventory document master's loaders resolve at
 * $ASHLR_HOME/fleet/fleet.json (FleetInventoryFileV1). v3.29.15 never wrote
 * this filename — the fixture carries the era's fleet-types.ts vocabulary
 * (FleetEngine, RepoStage, RepoHoldKind, FleetActor) inside the v:1 sections
 * the current readers enumerate.
 */
function oldFleetDocument(home) {
  return {
    v: 1,
    generatedAt: OLD_STAMP,
    repos: [
      { repo: 'ashlrai/phantom', stage: 'merge', enforcement: 'server', path: join(home, 'mirrors', 'ashlrai__phantom') },
      { repo: 'example.invalid/rehearsal', stage: 'propose', enforcement: 'local', path: join(home, 'mirrors', 'example__rehearsal') },
    ],
    lanes: [
      { lane: 'codex', slots: 2 },
      { lane: 'local', slots: 4 },
    ],
    seats: [
      { seat: 'codex-rehearsal', lane: 'codex' },
      { seat: 'local-rehearsal', lane: 'local' },
    ],
    holds: [
      {
        repo: 'example.invalid/rehearsal', kind: 'owner-hold',
        reason: 'rehearsal hold — fake value', since: OLD_STAMP,
        until: null, setBy: 'mason', landingId: 'rq-rehearsal-hold-1',
      },
    ],
  };
}

/** Bridge-owned ~/.ashlr-runs files the new `fleet brains`/`fleet memory` read. */
function oldRunsFiles(home) {
  const runs = join(home, '.ashlr-runs');
  const dispatchLog = [
    '2026-10-14 05:41:02 LEADER tick complete: 2 items considered',
    '2026-10-14 05:58:44 OPUS-LEADER plan accepted rq-rehearsal-1',
    '2026-10-14 06:03:19 AUTOAUTHOR wrote draft note rq-rehearsal-2',
    '2026-10-14 06:11:57 ORCH-JOB claimed RQ-REHEARSAL-3 from sol',
    '2026-10-14 06:12:30 ORCH-JOB claimed RQ-REHEARSAL-4 from claude',
    'not-a-stamped-line',
  ].join('\n') + '\n';
  return [
    { path: join(runs, 'memstat.json'), data: { ts: OLD_STAMP, free_pct: 31.5, swap_gb: 1.25, swapouts_per_min: 0.4, disk_gb: 118.2 } },
    { path: join(runs, '.memguard2.json'), data: { level: 1, stopped: ['RQ-REHEARSAL-9'] } },
    { path: join(runs, 'queue', 'dispatch-events.log'), text: dispatchLog },
  ];
}

export const SEEDED_STATE_FILES = Object.freeze(['config.json', 'daemon.json', join('fleet', 'fleet.json')]);

/**
 * Write the old-shaped fixture into `<home>/.ashlr` (+ the bridge's
 * ~/.ashlr-runs inputs). Files are mode 0600 inside a 0700 home, matching
 * what the strict readers require. Returns the seeded state-file paths.
 */
export function seedOldHome(home) {
  const ashlr = join(home, '.ashlr');
  const seeded = [
    { path: join(ashlr, 'config.json'), data: oldConfigDocument(home) },
    { path: join(ashlr, 'daemon.json'), data: oldDaemonDocument() },
    { path: join(ashlr, 'fleet', 'fleet.json'), data: oldFleetDocument(home) },
    ...oldRunsFiles(home),
  ];
  for (const file of seeded) {
    mkdirSync(resolve(file.path, '..'), { recursive: true, mode: 0o700 });
    if (file.data !== undefined) {
      writeFileSync(file.path, JSON.stringify(file.data, null, 2) + '\n', { mode: 0o600 });
    } else {
      writeFileSync(file.path, file.text, { mode: 0o600 });
    }
  }
  return seeded.map((file) => file.path);
}

// ---------------------------------------------------------------------------
// Child environment — a whitelist. No credential, token or provider variable
// crosses the boundary; everything the verbs resolve through HOME lands in
// the fixture directory.
// ---------------------------------------------------------------------------

const PASSTHROUGH_ENV = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  // Windows process requirements.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'PROGRAMDATA',
];

export function rehearsalEnv(home) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  env.ASHLR_HOME = join(home, '.ashlr');
  env.ASHLR_RUNS_DIR = join(home, '.ashlr-runs');
  env.CODEX_HOME = join(home, '.codex');
  env.CODEX_HOME_ALT = join(home, '.codex-2');
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  env.CI = '1';
  return env;
}

// ---------------------------------------------------------------------------
// Verb runner — the default child_process implementation; tests inject fakes.
// ---------------------------------------------------------------------------

/**
 * Run one verb synchronously under the seeded env.
 * Returns { status, signal, stdout, stderr, timedOut, spawnError }.
 */
export function spawnVerb(cli, argv, { env, cwd, timeoutMs }) {
  const result = spawnSync(process.execPath, [cli, ...argv], {
    env,
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = result.error !== undefined && result.error !== null &&
    result.error.code === 'ETIMEDOUT';
  const spawnError = result.error && !timedOut
    ? (result.error instanceof Error ? result.error.message : String(result.error))
    : null;
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    spawnError,
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * A Node stack frame (`    at fn (file:line:col)`, `at async ...`,
 * `at node:internal/...:l:c`) or an uncaught/unhandled banner. Plain
 * `error:` lines the CLI prints itself never match.
 */
const STACK_FRAME = /^\s+at\s+(?:async\s+)?[^\n]*:\d+:\d+\)?\s*$/m;
const UNCAUGHT = /^(?:Uncaught|UnhandledPromiseRejection|unhandledRejection)/m;

export function stderrHasStackTrace(stderr) {
  return STACK_FRAME.test(stderr) || UNCAUGHT.test(stderr);
}

/**
 * The strict loaders' unreadable vocabulary, matched precisely so the
 * constant prose in healthy output cannot false-positive:
 *   - `"reason"|"sourceState"|"state": "unreadable"|"malformed"` — the strict
 *     readers' verdict values (daemon.sourceQuality.reason et al.);
 *   - hyphenated diagnostic codes — `daemon-state-malformed`,
 *     `proposals-unreadable`, `malformed-file-header` — which only exist in
 *     output when an actual file failed to read;
 *   - the `[ashlr] Warning:` config fallback lines — an existing config that
 *     cannot be honored is unreadable even though loadConfig degrades.
 *
 * Things deliberately NOT matched: free text ("...missing or unreadable" /
 * "or malformed." detail strings are designed-absence prose), and camelCase
 * counters (`unreadableFiles`, `malformedLines`) which carry counts, not
 * verdicts.
 */
const STATE_UNREADABLE = new RegExp([
  '"(?:reason|sourceState|state)"\\s*:\\s*"(?:unreadable|malformed)"',
  '[a-z0-9]+-(?:unreadable|malformed)(?:-[a-z0-9]+)*\\b',
  '\\[ashlr\\] Warning: (?:could not read config|config file [^\\n]*(?:is not valid JSON|does not contain a JSON object))',
].join('|'), 'i');

export function outputReportsUnreadable(stdout, stderr) {
  return STATE_UNREADABLE.test(`${stdout}\n${stderr}`);
}

function evaluateVerb(verb, result, durationMs) {
  const stackTrace = stderrHasStackTrace(result.stderr);
  const stateUnreadable = outputReportsUnreadable(result.stdout, result.stderr);
  const expected = result.status !== null && verb.okExits.includes(result.status);
  const crashed = result.timedOut || result.signal !== null || result.spawnError !== null ||
    stackTrace || !expected;
  const reasons = [];
  if (result.timedOut) reasons.push('timeout');
  if (result.signal !== null) reasons.push(`signal-${result.signal}`);
  if (result.spawnError !== null) reasons.push(`spawn-error`);
  if (stackTrace) reasons.push('stack-trace');
  if (!expected && !result.timedOut && result.signal === null && result.spawnError === null) {
    reasons.push(`unexpected-exit-${result.status}`);
  }
  return {
    verb: verb.name,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    timedOut: result.timedOut,
    stackTrace,
    stateUnreadable,
    crashed,
    reasons,
    ...(crashed || stateUnreadable
      ? { stderrTail: result.stderr.trim().split('\n').slice(-6).join('\n').slice(-500) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Post-run state-file check — the seeded files in the loaders' own terms.
// ---------------------------------------------------------------------------

const FLEET_INVENTORY_MAX_BYTES = 256 * 1024;

function readJsonReport(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { exists: false, readable: false, detail: 'missing' };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, readable: false, detail: 'not-a-regular-file' };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { exists: true, readable: false, bytes: stat.size, detail: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { exists: true, readable: false, bytes: stat.size, detail: 'not-a-json-object' };
  }
  return { exists: true, readable: true, bytes: stat.size, parsed };
}

/**
 * Mirrors daemonStateIssueCodes' required-field checks from
 * src/core/daemon/state.ts (the contract is frozen since v3.29.15 — the verb
 * output scan additionally surfaces any live `daemon-state-*` rejection).
 */
export function daemonStateFixtureIssues(value) {
  const issues = [];
  if (typeof value['running'] !== 'boolean') issues.push('running-invalid');
  const pid = value['pid'];
  if (!(typeof pid === 'number' || pid === null)) issues.push('pid-invalid');
  if (!(typeof value['startedAt'] === 'string' || value['startedAt'] === null)) issues.push('started-at-invalid');
  if (!(typeof value['lastTickAt'] === 'string' || value['lastTickAt'] === null)) issues.push('last-tick-at-invalid');
  if (!(typeof value['todayDate'] === 'string' || value['todayDate'] === null)) issues.push('budget-day-invalid');
  if (typeof value['todaySpentUsd'] !== 'number' || !Number.isFinite(value['todaySpentUsd'])) issues.push('spend-invalid');
  if (typeof value['itemsProcessed'] !== 'number' || !Number.isFinite(value['itemsProcessed'])) issues.push('items-processed-invalid');
  if (!Array.isArray(value['ticks'])) issues.push('ticks-invalid');
  return issues;
}

export function checkStateFiles(home) {
  const ashlr = join(home, '.ashlr');
  const files = [
    { name: 'config.json', path: join(ashlr, 'config.json') },
    { name: 'daemon.json', path: join(ashlr, 'daemon.json') },
    { name: 'fleet/fleet.json', path: join(ashlr, 'fleet', 'fleet.json') },
  ];
  return files.map((file) => {
    const read = readJsonReport(file.path);
    const report = { name: file.name, path: file.path, ...read };
    delete report.parsed;
    if (!read.exists || !read.readable) return report;
    if (file.name === 'daemon.json') {
      const issues = daemonStateFixtureIssues(read.parsed);
      if (issues.length > 0) {
        return { ...report, readable: false, detail: `daemon-state issues: ${issues.join(', ')}` };
      }
    }
    if (file.name === 'fleet/fleet.json' && statSync(file.path).size > FLEET_INVENTORY_MAX_BYTES) {
      return { ...report, readable: false, detail: 'exceeds fleet inventory byte bound' };
    }
    return report;
  });
}

// ---------------------------------------------------------------------------
// Rehearsal
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.home            seeded temp HOME (required)
 * @param {string} [options.cli]           CLI entry; defaults to this tree's bin/ashlr
 * @param {Array}  [options.verbs]         verb list; defaults to FLEET_REHEARSAL_VERBS
 * @param {number} [options.timeoutMs]     per-verb bound; default 30_000
 * @param {(cli:string,argv:string[],o:{env:object,cwd:string,timeoutMs:number})=>object|Promise<object>} [options.runner]
 * @param {(home:string)=>string[]} [options.seed]
 * @param {(home:string)=>Array}  [options.checkState]
 * @param {object} [options.env]           child env override (default rehearsalEnv(home))
 * @param {string} [options.cwd]           verb working directory (default repo root)
 * @param {()=>number} [options.now]
 */
export async function runFleetUpgradeRehearsal({
  home,
  cli = DEFAULT_CLI,
  verbs = FLEET_REHEARSAL_VERBS,
  timeoutMs = FLEET_REHEARSAL_TIMEOUT_MS,
  runner = spawnVerb,
  seed = seedOldHome,
  checkState = checkStateFiles,
  env = undefined,
  cwd = REPO_ROOT,
  now = () => Date.now(),
} = {}) {
  if (typeof home !== 'string' || !isAbsolute(home)) fail('home must be an absolute path');
  const started = now();
  const seeded = seed(home);
  const childEnv = env ?? rehearsalEnv(home);

  const verbReports = [];
  for (const verb of verbs) {
    const began = now();
    const result = await runner(cli, [...verb.argv], { env: childEnv, cwd, timeoutMs });
    verbReports.push(evaluateVerb(verb, result, now() - began));
  }

  const stateFiles = checkState(home);
  const failures = [];
  for (const report of verbReports) {
    if (report.crashed) failures.push(`${report.verb}: crashed (${report.reasons.join(', ') || 'unknown'})`);
    if (report.stateUnreadable) failures.push(`${report.verb}: an old state file was reported unreadable`);
  }
  for (const file of stateFiles) {
    if (!file.readable) failures.push(`${file.name}: unreadable after run (${file.detail ?? 'missing'})`);
  }

  return {
    schema: 'fleet-upgrade-rehearsal.v1',
    home,
    cli,
    timeoutMs,
    generatedAt: new Date(started).toISOString(),
    durationMs: now() - started,
    seededFiles: seeded,
    stateFiles: stateFiles.map(file => Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'parsed'))),
    verbs: verbReports,
    failures,
    ok: failures.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function formatVerbTable(report) {
  const rows = report.verbs.map((verb) => [
    verb.verb,
    verb.timedOut ? 'TIMEOUT' : String(verb.exitCode ?? 'null'),
    `${verb.durationMs}ms`,
    verb.crashed ? `crash(${verb.reasons.join(',')})` : 'ok',
    verb.stackTrace ? 'yes' : 'no',
    verb.stateUnreadable ? 'yes' : 'no',
  ]);
  const head = ['verb', 'exit', 'duration', 'verdict', 'stack', 'unreadable'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const table = [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
  const files = report.stateFiles.map((file) =>
    `  ${file.readable ? 'ok ' : 'BAD'} ${file.name}${file.readable ? ` (${file.bytes}B)` : ` — ${file.detail ?? 'missing'}`}`,
  ).join('\n');
  const verdict = report.ok ? 'PASS — every verb ran inside its contract on the seeded v3.29.15 home.'
    : `FAIL —\n${report.failures.map((f) => `  - ${f}`).join('\n')}`;
  return `fleet upgrade rehearsal — ${report.home}\n\n${table}\n\nstate files\n${files}\n\n${verdict}\n`;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv) {
  const options = parseRehearsalArgs(argv);
  if (options.help) {
    process.stdout.write('usage: fleet-upgrade-rehearsal.mjs --home <dir> [--json]\n' +
      'Rehearse the v3.29.15 -> master jump: seed a temp HOME with old-shaped state,\n' +
      'run the fixed verb list, and fail on any crash or unreadable old state file.\n');
    return 0;
  }
  if (!existsSync(BUILT_CLI_ENTRY)) {
    fail(`${BUILT_CLI_ENTRY} is missing — run \`npm run build\` first`);
  }
  const report = await runFleetUpgradeRehearsal({ home: options.home });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatVerbTable(report));
  return report.ok ? 0 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
