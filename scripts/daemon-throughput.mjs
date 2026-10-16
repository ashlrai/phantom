#!/usr/bin/env node
/**
 * Offline concurrency harness for Phantom's resident-daemon dispatch path.
 *
 * Question: how many autonomous agents can run concurrently on ONE machine
 * before the shared-state primitives (not the model) start failing or
 * serializing? No model, no network, no credentials, no paid usage.
 *
 * For each N (default 5,10,20) it builds a fresh temp HOME + temp git repo,
 * enrolls the repo, then launches N OS processes at once. Each process
 * (scripts/daemon-throughput-worker.ts) walks the real primitives a
 * daemon-dispatched sandboxed producer touches, in production lock order:
 *
 *   shared fleet queue claim + begin    fleet/shared-store.ts (SharedWorkQueueCoordinator)
 *   run execution authority + saveRun   util/execution-lease.ts, run/orchestrator.ts
 *   repo lease -> createSandboxAsync    sandbox/execution-leases.ts, sandbox/worktree.ts
 *   admit: fence -> gate -> exec lease  sandbox/mutation-fence.ts (global, cross-process)
 *   fake engine: write one file         (optionally sleep --think-ms to model inference)
 *   repo lease -> fence -> file proposal -> remove worktree   inbox/store.ts createProposal
 *   terminal saveRun + queue outcome
 *
 * It reports per N: ok/failed (+ reasons), wall time, p50/p95 per phase and
 * end-to-end latency, leftover sandboxes / worktrees / branches / disk, and
 * peak per-process RSS.
 *
 * Usage:
 *   node scripts/daemon-throughput.mjs [--n 5,10,20] [--files 300] [--think-ms 0] [--json]
 *   ASHLR_MAX_SANDBOXES=32 node scripts/daemon-throughput.mjs --n 20
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, 'daemon-throughput-worker.ts');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const ns = opt('n', '5,10,20').split(',').map(Number);
const fileCount = Number(opt('files', '300'));
const thinkMs = Number(opt('think-ms', '0'));
const asJson = args.includes('--json');

function sh(cwd, env, cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function duKb(path) {
  if (!existsSync(path)) return 0;
  const r = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  return Number((r.stdout ?? '0').split(/\s/)[0]) || 0;
}

function pct(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-throughput-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home); mkdirSync(join(repo, 'src'), { recursive: true });
  const gitCfg = join(root, 'gitconfig');
  writeFileSync(gitCfg, '[user]\n\tname = bench\n\temail = bench@example.invalid\n[init]\n\tdefaultBranch = main\n');
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_NOSYSTEM: '1',
    ...(process.env.ASHLR_MAX_SANDBOXES ? { ASHLR_MAX_SANDBOXES: process.env.ASHLR_MAX_SANDBOXES } : {}),
  };
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(repo, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(40));
  }
  sh(repo, env, 'git', ['init', '-q']);
  sh(repo, env, 'git', ['add', '-A']);
  sh(repo, env, 'git', ['commit', '-qm', 'seed']);
  const enrolled = spawnSync(process.execPath, ['--import', 'tsx', worker, '--setup', repo], { env, encoding: 'utf8', cwd: resolve(here, '..') });
  if (enrolled.status !== 0) throw new Error(`enroll failed: ${enrolled.stdout}${enrolled.stderr}`);
  return { root, home, repo, env, queueDir: join(root, 'shared-queue') };
}

function runAgent(ctx, idx, n) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ctx.repo, ctx.queueDir, String(idx), String(n), String(thinkMs)], {
      env: ctx.env, cwd: resolve(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      const line = out.trim().split('\n').pop() ?? '';
      try { done(JSON.parse(line)); } catch { done({ idx, ok: false, failure: `exit ${code}: ${err.trim().slice(-200)}`, phases: {} }); }
    });
  });
}

async function measure(n) {
  const ctx = setup();
  try {
    const t = Date.now();
    const results = await Promise.all(Array.from({ length: n }, (_, i) => runAgent(ctx, i, n)));
    const wallMs = Date.now() - t;
    const failures = {};
    for (const r of results.filter((x) => !x.ok)) {
      const key = String(r.failure).replace(/[0-9a-f]{12}/g, '<id>').slice(0, 120);
      failures[key] = (failures[key] ?? 0) + 1;
    }
    const phaseNames = [...new Set(results.flatMap((r) => Object.keys(r.phases ?? {})))];
    const phases = Object.fromEntries(phaseNames.map((p) => {
      const v = results.map((r) => r.phases?.[p]).filter((x) => typeof x === 'number');
      return [p, { p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) }];
    }));
    const totals = results.map((r) => r.totalMs).filter((x) => typeof x === 'number');
    const sandboxes = join(ctx.home, '.ashlr', 'sandboxes');
    const leftoverHomes = existsSync(sandboxes) ? readdirSync(sandboxes).filter((e) => !e.startsWith('.') && statSync(join(sandboxes, e)).isDirectory()).length : 0;
    const worktrees = sh(ctx.repo, ctx.env, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length - 1;
    const branches = sh(ctx.repo, ctx.env, 'git', ['branch', '--list', 'ashlr/sandbox/*']).split('\n').filter(Boolean).length;
    const inbox = join(ctx.home, '.ashlr', 'inbox');
    const proposals = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith('.json')).length : 0;
    return {
      n, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, failures, wallMs,
      agentMs: { p50: pct(totals, 50), p95: pct(totals, 95), max: Math.max(...totals) },
      phases, leftover: { sandboxHomes: leftoverHomes, worktrees, branches, sandboxesDiskKb: duKb(sandboxes) },
      proposals, peakRssMb: Math.round(Math.max(...results.map((r) => r.maxRssKb ?? 0)) / 1024),
    };
  } finally {
    if (!process.env.ASHLR_BENCH_KEEP) rmSync(ctx.root, { recursive: true, force: true });
  }
}

const reports = [];
for (const n of ns) reports.push(await measure(n));
if (asJson) {
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
} else {
  const f = (x) => (x === null || x === undefined ? '-' : Math.round(x));
  for (const r of reports) {
    console.log(`\nN=${r.n}: ok ${r.ok}/${r.n}, wall ${r.wallMs}ms, agent p50/p95 ${f(r.agentMs.p50)}/${f(r.agentMs.p95)}ms, peak RSS ${r.peakRssMb}MB, proposals ${r.proposals}`);
    console.log(`  leftover: ${r.leftover.sandboxHomes} sandbox homes, ${r.leftover.worktrees} worktrees, ${r.leftover.branches} branches, ${r.leftover.sandboxesDiskKb}KB`);
    for (const [k, v] of Object.entries(r.failures)) console.log(`  FAIL x${v}: ${k}`);
    for (const [k, v] of Object.entries(r.phases)) console.log(`  ${k.padEnd(20)} p50 ${String(f(v.p50)).padStart(6)}  p95 ${String(f(v.p95)).padStart(6)}  max ${String(f(v.max)).padStart(6)} ms`);
  }
}
