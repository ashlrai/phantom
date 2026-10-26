#!/usr/bin/env node
/**
 * Crash/soak harness: what does an unattended Phantom daemon leave behind
 * after a hard crash, once it restarts and its start-up recovery has run?
 *
 * Offline: a throwaway HOME (ASHLR_HOME under it) and temp git repo, a fake
 * engine, no model, no network, no credentials. Modelled on
 * scripts/daemon-throughput.mjs.
 *
 * Each cycle:
 *   1. starts --n agents at once (scripts/daemon-chaos-worker.ts), each walking
 *      the daemon's sandboxed-producer primitives and printing `PHASE <name>`;
 *   2. SIGKILLs agents at seeded random points: during sandbox creation
 *      (reservation / REGISTER / checkout), at admission, mid-run, while
 *      settling (proposal filing + sandbox removal), during the inbox
 *      temp-worktree verify, while applying the proposal and while a fleet
 *      scratch repository is open. Some cycles kill every agent at once (a daemon
 *      crash); others kill single agents. A kill hits either the process
 *      alone (its git children run on, as after an OOM kill) or its whole
 *      process group;
 *   3. restarts: runs the start-up recovery runDaemon performs (orphan sandbox
 *      sweep, leaked temp-worktree sweep, tmp scratch sweep, stale git lock
 *      report; see the worker's --restart);
 *   4. audits residue and prints one row per cycle.
 *
 * Residue classes. HARD residue must be gone after a restart and fails the run:
 *   homes       sandbox homes under ~/.ashlr/sandboxes (these count against the cap)
 *   worktrees   linked worktrees still registered (`git worktree list`)
 *   branches    scratch branches (refs/heads/ashlr/sandbox/*, ashlr/verify/*); an
 *               applied proposal's ashlr/proposal/* branch is apply's output, kept
 *   gitLocks    *.lock files under the repo's .git (index.lock, ref locks, ...)
 *   tmp         entries under ~/.ashlr/tmp (temp worktrees, owner markers, patch files,
 *               fleet-git-* scratch repositories)
 *   wedged      1 when the next tick's first queue claim + outcome record fails, and
 *               still fails when re-run as if every stale-lock window had passed
 *   strays      processes left over from a killed agent
 * SOFT residue is reported; it is either reclaimed lazily by the next acquirer
 * or kept on purpose as fail-closed evidence (pass --strict to fail on it too):
 *   deadLocks   lock files under ASHLR_HOME whose recorded owner pid is dead
 *   execMarks   run execution-authority markers left in phase `executing`
 *   execClaims  shared-queue claims left in phase `executing`
 *   running     run records still `running` with no live owner
 *   pendingHomes sandbox homes the orphan sweep reclaims only once a minute old:
 *               metadata-free homes (a kill between the metadata unlink and the
 *               rmdir) and homes left with only their scratch branch (a kill
 *               between `worktree remove` and `branch -D`, or inside `worktree add`;
 *               their branch is counted here too, not under branches). --settle
 *               waits that minute after the last cycle and restarts once more
 *   queueWait   the queue is blocked now but recovers once the dead holder's lock is
 *               2x the lease old (the shared store spans machines). A stranded
 *               unlink guard is dropped by that age; a stranded commit guard only
 *               when its owner record proves a dead holder on this host, which a
 *               SIGKILLed agent here always is (so the aged probe recovers it). A
 *               live, foreign-host or unrecorded holder stays wedged on purpose
 *   queueLitter --queue shared only: capability probes, temp files and guard owner
 *               records left in the shared queue directory that block nothing
 *
 * SIGINT/SIGTERM kill every tracked agent process group and remove the run's
 * temp base directory (unless --keep) before exiting.
 *
 * Usage:
 *   node scripts/daemon-chaos.mjs [--cycles 10] [--seed 1] [--n 4] [--files 120]
 *     [--think-ms 300] [--verify 1] [--queue local|shared] [--settle] [--strict] [--json] [--keep]
 * Several seeds: node scripts/daemon-chaos.mjs --seed 1,2,3 --cycles 10
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const worker = join(here, 'daemon-chaos-worker.ts');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const cycles = Number(opt('cycles', '10'));
const seeds = String(opt('seed', '1')).split(',').map(Number);
const agents = Number(opt('n', '4'));
const fileCount = Number(opt('files', '120'));
const thinkMs = Number(opt('think-ms', '300'));
const verify = opt('verify', '1') !== '0';
const queueMode = opt('queue', 'local') === 'shared' ? 'shared' : 'local';
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const keep = args.includes('--keep') || Boolean(process.env.ASHLR_BENCH_KEEP);
const settle = args.includes('--settle');

const HARD = ['homes', 'worktrees', 'branches', 'gitLocks', 'tmp', 'wedged', 'strays'];
const SOFT = ['pendingHomes', 'queueWait', 'queueLitter', 'deadLocks', 'execMarks', 'execClaims', 'running'];
// worktree.ts reclaims a metadata-free sandbox home only once it is a minute old.
const RESERVATION_RECOVERY_MS = 60_000;
// Kill points and how long after entering the phase to strike (ms, uniform).
const KILL_POINTS = {
  queueClaim: 40, runTerminal: 40, sandboxCreate: 900, admit: 60, engine: thinkMs, settle: 250, sandboxRemove: 250, verify: 2_500,
  apply: 400, fleetScratch: Math.max(50, thinkMs),
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sh(cwd, env, cmd, cmdArgs, allowFail = false) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${cmdArgs.join(' ')}: ${r.stderr}`);
  return r.stdout ?? '';
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'ashlr-chaos-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home); mkdirSync(join(repo, 'src'), { recursive: true });
  const gitCfg = join(base, 'gitconfig');
  writeFileSync(gitCfg, '[user]\n\tname = chaos\n\temail = chaos@example.invalid\n[init]\n\tdefaultBranch = main\n');
  const env = {
    PATH: process.env.PATH, HOME: home, ASHLR_HOME: join(home, '.ashlr'), TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_NOSYSTEM: '1', ASHLR_MAX_SANDBOXES: String(Math.max(16, agents * 4)),
  };
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(repo, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(40));
  }
  // A verify command for the temp-worktree verify phase: offline, ~0.5 s.
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({
    name: 'chaos-target', private: true, scripts: { test: 'node -e "setTimeout(() => {}, 500)"' },
  }, null, 2)}\n`);
  sh(repo, env, 'git', ['init', '-q']);
  sh(repo, env, 'git', ['add', '-A']);
  sh(repo, env, 'git', ['commit', '-qm', 'seed']);
  const enrolled = spawnSync(process.execPath, ['--import', 'tsx', worker, '--setup', repo], { env, encoding: 'utf8', cwd: root });
  if (enrolled.status !== 0) throw new Error(`enroll failed: ${enrolled.stdout}${enrolled.stderr}`);
  return { base, home, repo, env, ashlr: join(home, '.ashlr'), queueDir: join(base, 'shared-queue') };
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live agent process groups and the current run's base dir, for the signal handlers. */
const liveGroups = new Set();
let liveBase = null;
let stopping = false;
function stopOnSignal(signal) {
  if (stopping) return;
  stopping = true;
  for (const pgid of liveGroups) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (liveBase && !keep) {
    try { rmSync(liveBase, { recursive: true, force: true }); } catch { /* best effort */ }
  } else if (liveBase) {
    console.error(`kept ${liveBase}`);
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGINT', () => stopOnSignal('SIGINT'));
process.on('SIGTERM', () => stopOnSignal('SIGTERM'));

/** Wait for every process in a killed agent's group to exit; SIGKILL the group after a grace. */
async function drainGroup(pgid, graceMs = 20_000) {
  const until = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < until) await sleep(50);
  if (groupAlive(pgid)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
    await sleep(100);
    return groupAlive(pgid) ? 1 : 0;
  }
  return 0;
}

function runAgent(ctx, idx, plan, crash) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ctx.repo, ctx.queueDir, String(idx), String(agents), String(thinkMs), verify ? '1' : '0', queueMode], {
      env: ctx.env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    liveGroups.add(child.pid);
    let out = ''; let err = ''; let killedAt = null; let lastPhase = null;
    const strike = (mode, where) => {
      if (killedAt !== null || child.exitCode !== null) return;
      killedAt = where;
      try { process.kill(mode === 'group' ? -child.pid : child.pid, 'SIGKILL'); } catch { /* exited */ }
    };
    if (crash) crash.register((where) => strike(crash.mode, where));
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of String(d).split('\n')) {
        if (!line.startsWith('PHASE ')) continue;
        lastPhase = line.slice(6).trim();
        if (plan && lastPhase === plan.phase) setTimeout(() => strike(plan.mode, `${plan.phase}+${plan.delay}ms`), plan.delay);
        if (crash && lastPhase === crash.phase) crash.trigger(`${crash.phase}+${crash.delay}ms`);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', async (code, signal) => {
      const strays = await drainGroup(child.pid);
      liveGroups.delete(child.pid);
      const resultLine = out.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
      let result = null;
      try { result = resultLine ? JSON.parse(resultLine.slice(7)) : null; } catch { result = null; }
      done({ idx, killedAt, lastPhase, code, signal, strays, result, stderrTail: result ? '' : err.trim().slice(-300) });
    });
  });
}

/** Can the next tick still claim and record queue work? 1 = blocked. */
function probeQueue(ctx, aged = false) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', worker, '--probe', ctx.queueDir, queueMode, ...(aged ? ['aged'] : [])], { env: ctx.env, cwd: root, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  try { return JSON.parse(line.slice(7)).claimed ? 0 : 1; } catch { return 1; }
}

function restart(ctx) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', worker, '--restart'], { env: ctx.env, cwd: root, encoding: 'utf8', timeout: 300_000 });
  const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  try { return JSON.parse(line.slice(7)); } catch { return { crash: `restart exit ${r.status}: ${(r.stderr ?? '').slice(-300)}` }; }
}

function walk(dir, visit, depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) { if (depth < 12) walk(p, visit, depth + 1); } else visit(p, e);
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function audit(ctx) {
  const detail = {};
  const sandboxes = join(ctx.ashlr, 'sandboxes');
  const homes = existsSync(sandboxes) ? readdirSync(sandboxes).filter((e) => !e.startsWith('.')) : [];
  const porcelain = sh(ctx.repo, ctx.env, 'git', ['worktree', 'list', '--porcelain'], true);
  const blocks = porcelain.split('\n\n').filter((b) => b.startsWith('worktree '));
  const registered = new Set(blocks.map((b) => b.split('\n')[0].slice('worktree '.length)));
  const allBranches = sh(ctx.repo, ctx.env, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/ashlr/'], true)
    .split('\n').filter(Boolean).filter((b) => !b.startsWith('ashlr/proposal/'));
  // A home holding only its metadata and a scratch branch, under a minute old.
  const strandedYoung = (e) => {
    const home = join(sandboxes, e);
    const meta = readJson(join(home, 'sandbox.json'));
    if (!meta || existsSync(join(home, 'worktree')) || registered.has(join(home, 'worktree'))) return false;
    if (!allBranches.includes(`ashlr/sandbox/${e}`)) return false;
    let freshest = Date.parse(meta.createdAt);
    try { freshest = Math.max(freshest, lstatSync(home).mtimeMs, lstatSync(join(home, 'sandbox.json')).mtimeMs); } catch { return false; }
    return Date.now() - freshest < RESERVATION_RECOVERY_MS;
  };
  const withMeta = homes.filter((e) => existsSync(join(sandboxes, e, 'sandbox.json')));
  const young = withMeta.filter(strandedYoung);
  detail.homes = withMeta.filter((e) => !young.includes(e));
  detail.pendingHomes = [...homes.filter((e) => !existsSync(join(sandboxes, e, 'sandbox.json'))), ...young];
  detail.worktrees = blocks.slice(1).map((b) => {
    const path = b.split('\n')[0].slice('worktree '.length);
    const flags = ['locked', 'prunable'].filter((f) => b.split('\n').some((l) => l === f || l.startsWith(`${f} `)));
    return flags.length ? `${basename(path)}(${flags.join(',')})` : basename(path);
  });
  detail.branches = allBranches.filter((b) => !young.some((e) => b === `ashlr/sandbox/${e}`));
  detail.gitLocks = [];
  walk(join(ctx.repo, '.git'), (p) => { if (p.endsWith('.lock')) detail.gitLocks.push(p.slice(ctx.repo.length + 1)); });
  const tmp = join(ctx.ashlr, 'tmp');
  detail.tmp = existsSync(tmp) ? readdirSync(tmp) : [];
  const queueFiles = existsSync(ctx.queueDir) ? readdirSync(ctx.queueDir) : [];
  const queueLock = join(ctx.queueDir, 'ashlr-fleet-queue.json.lock');
  let lockLinks = 0;
  try { lockLinks = lstatSync(queueLock).nlink; } catch { lockLinks = 0; }
  detail.queueLitter = queueFiles.filter((f) => f !== 'ashlr-fleet-queue.json' && f !== 'ashlr-fleet-queue.json.lock' &&
    !(lockLinks > 1 && f.startsWith('ashlr-fleet-queue.json.lock.')));
  detail.queueLock = lockLinks;
  detail.deadLocks = [];
  walk(ctx.ashlr, (p, e) => {
    const name = e.name;
    if (!(name.endsWith('.lock') || name.startsWith('.lock') || /\.lock-v1-/.test(name) || name === 'lock')) return;
    const owner = readJson(p);
    const pid = owner && typeof owner.pid === 'number' ? owner.pid : null;
    if (pid !== null && !pidAlive(pid)) detail.deadLocks.push(p.slice(ctx.ashlr.length + 1));
  });
  detail.execMarks = [];
  const leases = join(ctx.ashlr, 'execution-leases');
  if (existsSync(leases)) {
    for (const f of readdirSync(leases)) {
      if (!f.startsWith('.state-v1-')) continue;
      const m = readJson(join(leases, f));
      if (m && m.phase === 'executing') detail.execMarks.push(f.slice(10, 22));
    }
  }
  detail.execClaims = [];
  const queue = readJson(join(ctx.queueDir, 'ashlr-fleet-queue.json'));
  for (const [item, claim] of Object.entries(queue?.claims ?? {})) {
    const parts = String(claim.machineId).split(':');
    if (parts[1] === 'e') detail.execClaims.push(item);
  }
  detail.running = [];
  const runs = join(ctx.ashlr, 'runs');
  if (existsSync(runs)) {
    for (const f of readdirSync(runs)) {
      if (!f.endsWith('.json')) continue;
      const r = readJson(join(runs, f));
      if (r && r.status === 'running') detail.running.push(r.id);
    }
  }
  return detail;
}

function counts(detail, strays) {
  const c = { strays };
  for (const k of [...HARD, ...SOFT]) if (k !== 'strays') c[k] = detail[k].length;
  return c;
}

async function runCycle(ctx, rnd, cycle) {
  const pointNames = Object.keys(KILL_POINTS).filter((p) => verify || p !== 'verify');
  const pick = () => pointNames[Math.floor(rnd() * pointNames.length)];
  const mode = () => (rnd() < 0.5 ? 'group' : 'pid');
  const daemonCrash = rnd() < 0.4;
  let crash = null;
  const plans = [];
  if (daemonCrash) {
    // One process-wide crash: every agent dies when the first one reaches the point.
    const phase = pick();
    const strikes = [];
    let fired = false;
    crash = {
      phase, delay: Math.floor(rnd() * KILL_POINTS[phase]), mode: mode(),
      register: (fn) => strikes.push(fn),
      trigger(where) { if (fired) return; fired = true; setTimeout(() => strikes.forEach((s) => s(where)), crash.delay); },
    };
    for (let i = 0; i < agents; i++) plans.push(null);
  } else {
    for (let i = 0; i < agents; i++) {
      if (rnd() < 0.25) { plans.push(null); continue; }
      const phase = pick();
      plans.push({ phase, delay: Math.floor(rnd() * KILL_POINTS[phase]), mode: mode() });
    }
  }
  const results = await Promise.all(plans.map((plan, i) => runAgent(ctx, i, plan, crash)));
  const strays = results.reduce((s, r) => s + r.strays, 0);
  return restartAndAudit(ctx, results, strays, cycle, daemonCrash ? `daemon@${crash.phase}/${crash.mode}` : 'agents');
}

function restartAndAudit(ctx, results, strays, cycle, kind) {
  const before = counts({ ...audit(ctx), wedged: [], queueWait: [] }, strays);
  const restarted = restart(ctx);
  const detail = audit(ctx);
  // Blocked now: probe again as if every stale-lock window had passed. Blocked
  // then too means nothing will ever unblock the queue. (The aged probe takes
  // over what it can, as a later real tick would.)
  const blocked = probeQueue(ctx) === 1;
  const forever = blocked && probeQueue(ctx, true) === 1;
  detail.queueWait = blocked && !forever ? [`queue-lock-links=${detail.queueLock}`] : [];
  detail.wedged = forever ? [`queue-lock-links=${detail.queueLock}`] : [];
  const after = counts(detail, strays);
  const hard = HARD.reduce((s, k) => s + after[k], 0);
  const soft = SOFT.reduce((s, k) => s + after[k], 0);
  return {
    cycle, kind,
    kills: results.filter((r) => r.killedAt).map((r) => r.killedAt),
    completed: results.filter((r) => r.result?.ok).length,
    failures: results.filter((r) => r.result && !r.result.ok).map((r) => String(r.result.failure).slice(0, 120)),
    before, after, hard, soft, restarted,
    residue: Object.fromEntries([...HARD, ...SOFT].filter((k) => k !== 'strays' && detail[k].length).map((k) => [k, detail[k].slice(0, 6)])),
  };
}

function row(r) {
  const cell = (k) => String(r.after[k]).padStart(Math.max(4, k.length));
  return `${String(r.cycle).padStart(5)}  ${r.kind.padEnd(24)} ${String(r.kills.length).padStart(5)} ${String(r.completed).padStart(4)}  ` +
    `${[...HARD, ...SOFT].map(cell).join(' ')}`;
}

const header = `cycle  kind                     kills   ok  ${[...HARD, ...SOFT].map((k) => k.padStart(Math.max(4, k.length))).join(' ')}`;
const summaries = [];
let failed = false;
for (const seed of seeds) {
  const rnd = mulberry32(seed);
  const ctx = setup();
  liveBase = ctx.base;
  const rows = [];
  let settled = null;
  if (!asJson) console.log(`\nseed ${seed}: ${cycles} cycles x ${agents} agents, ${queueMode} queue (residue AFTER restart + sweep)\n${header}`);
  try {
    for (let c = 1; c <= cycles; c++) {
      const r = await runCycle(ctx, rnd, c);
      rows.push(r);
      if (!asJson) {
        console.log(row(r));
        if (r.hard > 0 || (strict && r.soft > 0)) console.log(`       residue: ${JSON.stringify(r.residue)}`);
        if (r.restarted?.crash) console.log(`       restart crashed: ${r.restarted.crash}`);
      }
    }
    if (settle) {
      // No agents: wait out the age-gated recoveries, restart once more.
      await sleep(RESERVATION_RECOVERY_MS + 2_000);
      settled = restartAndAudit(ctx, [], 0, 'end', 'settle (+62s, no agents)');
      if (!asJson) {
        console.log(row(settled));
        if (settled.hard > 0 || settled.soft > 0) console.log(`       residue: ${JSON.stringify(settled.residue)}`);
      }
    }
  } finally {
    if (!keep) rmSync(ctx.base, { recursive: true, force: true });
    else if (!asJson) console.log(`kept ${ctx.base}`);
    liveBase = null;
  }
  const cyclesWithHard = rows.filter((r) => r.hard > 0).length;
  const cyclesWithSoft = rows.filter((r) => r.soft > 0).length;
  const keys = [...HARD, ...SOFT];
  const summary = {
    seed, cycles, agents, kills: rows.reduce((s, r) => s + r.kills.length, 0), cyclesWithHard, cyclesWithSoft,
    // Peak per-cycle residue left AFTER restart + sweep, and what the last cycle ended with.
    peakAfterRestart: Object.fromEntries(keys.map((k) => [k, Math.max(0, ...rows.map((r) => r.after[k]))])),
    finalAfterRestart: rows.length ? rows[rows.length - 1].after : null,
    afterSettle: settled ? settled.after : undefined,
    // Residue the kills produced before the restart ran (sum over cycles).
    producedBeforeRestart: Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + Math.max(0, r.before[k] - (rows[rows.indexOf(r) - 1]?.after[k] ?? 0)), 0)])),
    failures: rows.flatMap((r) => r.failures).reduce((m, f) => {
      const key = f.replace(/[0-9a-f]{12}/g, '<id>').replace(/\d+ms/g, '<n>ms'); m[key] = (m[key] ?? 0) + 1; return m;
    }, {}),
    rows: asJson ? rows : undefined,
  };
  summaries.push(summary);
  if (cyclesWithHard > 0 || (strict && cyclesWithSoft > 0)) failed = true;
  if (settled && (settled.hard > 0 || settled.after.pendingHomes > 0)) failed = true;
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
} else {
  console.log('\nsummary');
  for (const s of summaries) {
    console.log(`  seed ${s.seed}: kills ${s.kills}, cycles with hard residue ${s.cyclesWithHard}/${s.cycles}, with soft ${s.cyclesWithSoft}/${s.cycles}`);
    console.log(`    produced by kills (before restart): ${JSON.stringify(s.producedBeforeRestart)}`);
    console.log(`    peak left after restart + sweep:    ${JSON.stringify(s.peakAfterRestart)}`);
    console.log(`    final state:                        ${JSON.stringify(s.finalAfterRestart)}`);
    if (s.afterSettle) console.log(`    after settle:                       ${JSON.stringify(s.afterSettle)}`);
    for (const [k, v] of Object.entries(s.failures)) console.log(`    agent failure x${v}: ${k}`);
  }
}
process.exitCode = failed ? 1 : 0;
