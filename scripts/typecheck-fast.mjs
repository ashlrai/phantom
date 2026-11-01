import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedPaths, selectChangedFiles } from './verify-changed.mjs';

export function parseArgs(argv) {
  const options = { slots: Number(process.env.PHANTOM_TSC_SLOTS ?? 4), waitSeconds: 600, timeoutSeconds: 900, seed: true, json: false, help: false };
  const numbers = { '--slots': 'slots', '--wait-seconds': 'waitSeconds', '--timeout-seconds': 'timeoutSeconds' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-seed') options.seed = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--project') {
      options.project = argv[++i];
      if (!['backend', 'web', 'all'].includes(options.project)) throw new Error('Invalid --project');
    } else if (numbers[arg]) options[numbers[arg]] = Number(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  for (const key of Object.values(numbers)) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'waitSeconds' ? 0 : 1)) throw new Error(`Invalid ${key}`);
  }
  return options;
}

export function selectProjects(changedPaths, projectFlag) {
  if (projectFlag === 'all') return ['backend', 'web'];
  if (projectFlag) return [projectFlag];
  return selectChangedFiles(changedPaths, []).webTypecheck ? ['backend', 'web'] : ['backend'];
}

export function slotState({ pidAlive, ageMs, now }) {
  void now;
  if (pidAlive == null) return 'free';
  return !pidAlive || ageMs > 40 * 60_000 ? 'stale' : 'held';
}

export function seedDecision({ localMtimeMs, sharedMtimeMs }) {
  if (sharedMtimeMs == null) return localMtimeMs == null ? 'none' : 'keep';
  return localMtimeMs == null || sharedMtimeMs > localMtimeMs ? 'copy-in' : 'keep';
}

export function verdictLine(r) {
  if (r.status === 'DEFER') return `DEFER typecheck: ${r.slots} typechecks already running on this host; Merge Gate runs the full check`;
  if (r.status === 'TIMEOUT') return `TIMEOUT typecheck ${r.project} after ${r.seconds}s`;
  const detail = r.status === 'FAIL' ? `: ${r.errors} error(s)` : '';
  return `${r.status} typecheck ${r.project}${detail} in ${r.seconds}s (cache ${r.cache})`;
}

function mtime(path) {
  try { return statSync(path).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Atomic mkdir is the admission decision; an ownerless slot gets a short grace
// period so another contender cannot reclaim it before its owner is written.
export function acquireSlot(cacheDir, slots, now = Date.now()) {
  const parent = resolve(cacheDir, 'phantom-tsc-slots');
  mkdirSync(parent, { recursive: true });
  for (let i = 0; i < slots; i++) {
    const path = resolve(parent, `slot-${i}`);
    try { mkdirSync(path); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        let ageMs = now - statSync(path).mtimeMs;
        let pidAlive = true;
        try {
          const [pid, timestamp] = readFileSync(resolve(path, 'owner'), 'utf8').trim().split(' ');
          const parsed = Date.parse(timestamp);
          if (Number.isFinite(parsed)) ageMs = now - parsed;
          if (/^[1-9]\d*$/.test(pid)) {
            try { process.kill(Number(pid), 0); } catch (err) { if (err.code === 'ESRCH') pidAlive = false; }
          }
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (slotState({ pidAlive, ageMs, now }) !== 'stale') continue;
        rmSync(path, { recursive: true, force: true });
        try { mkdirSync(path); } catch (err) { if (err.code === 'EEXIST') continue; throw err; }
      } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    }
    const owner = `${process.pid} ${new Date(now).toISOString()}`;
    try { writeFileSync(resolve(path, 'owner'), owner); } catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
    return () => {
      try { if (readFileSync(resolve(path, 'owner'), 'utf8') === owner) rmSync(path, { recursive: true, force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  return null;
}

function runProject(root, project, local, timeoutSeconds, setChild) {
  return new Promise((done) => {
    const start = Date.now();
    const cache = mtime(local) == null ? 'cold' : 'warm';
    const config = project === 'backend' ? 'tsconfig.json' : 'src/web-ui/tsconfig.json';
    // Tee diagnostics unchanged while counting TypeScript diagnostic codes.
    const child = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', local, '-p', config], { cwd: root, detached: true, stdio: ['inherit', 'pipe', 'pipe'] });
    setChild(child);
    let errors = 0;
    const tails = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      process[stream].write(chunk);
      const text = tails[stream] + chunk.toString();
      const lines = text.split('\n');
      tails[stream] = lines.pop();
      errors += lines.reduce((n, line) => n + (line.match(/error TS\d+:/g)?.length ?? 0), 0);
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutSeconds * 1000);
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      setChild(null);
      for (const tail of Object.values(tails)) errors += tail.match(/error TS\d+:/g)?.length ?? 0;
      done({ project, status: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL', seconds: timedOut ? timeoutSeconds : Math.round((Date.now() - start) / 100) / 10, cache, errors, completed: code !== null });
    });
  });
}

function killGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/typecheck-fast.mjs [--project backend|web|all] [--slots N] [--wait-seconds N] [--timeout-seconds N] [--no-seed] [--json] [--help]');
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const projects = selectProjects(options.project ? [] : collectChangedPaths(root), options.project);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const shared = resolve(process.env.PHANTOM_TSC_CACHE_DIR ?? resolve(root, common, '..', 'node_modules/.cache'));
  const notes = new Set();
  const note = (error) => {
    const message = `NOTE typecheck shared cache: ${error.code ?? error.message}`;
    if (!notes.has(message)) { notes.add(message); console.error(message); }
  };
  const print = (result) => console.log(options.json ? JSON.stringify({ project: result.project ?? null, status: result.status, seconds: result.seconds ?? 0, cache: result.cache ?? null, errors: result.errors ?? 0 }) : verdictLine(result));
  let release;
  let child;
  const interrupt = (signal) => { killGroup(child); release?.(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    const deadline = Date.now() + options.waitSeconds * 1000;
    do {
      try { release = acquireSlot(shared, options.slots); } catch (error) { note(error); }
      if (release || Date.now() >= deadline) break;
      await new Promise((done) => setTimeout(done, Math.min(5000, deadline - Date.now())));
    } while (true);
    if (!release) { print({ status: 'DEFER', slots: options.slots }); process.exitCode = 3; return; }
    for (const project of projects) {
      const name = `phantom-${project}.tsbuildinfo`;
      const local = resolve(root, 'node_modules/.cache', name);
      const target = resolve(shared, name);
      mkdirSync(dirname(local), { recursive: true });
      if (options.seed && local !== target) {
        try { if (seedDecision({ localMtimeMs: mtime(local), sharedMtimeMs: mtime(target) }) === 'copy-in') copyFileSync(target, local); } catch (error) { note(error); }
      }
      const result = await runProject(root, project, local, options.timeoutSeconds, (value) => { child = value; });
      if (options.seed && local !== target && result.status !== 'TIMEOUT' && (result.status === 'PASS' || result.errors > 0) && result.completed) {
        const temp = resolve(shared, `.${name}.${process.pid}.tmp`);
        try {
          const localTime = mtime(local);
          if (localTime != null && (mtime(target) ?? -Infinity) < localTime) {
            mkdirSync(shared, { recursive: true });
            copyFileSync(local, temp);
            if ((mtime(target) ?? -Infinity) < localTime) renameSync(temp, target);
          }
        } catch (error) { note(error); }
        finally { try { rmSync(temp, { force: true }); } catch (error) { note(error); } }
      }
      print(result);
      if (result.status === 'TIMEOUT') { process.exitCode = 4; return; }
      if (result.status === 'FAIL') process.exitCode = 1;
    }
  } finally {
    release?.();
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
