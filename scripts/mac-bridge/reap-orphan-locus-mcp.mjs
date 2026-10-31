#!/usr/bin/env node
/**
 * Reap orphaned locus-mcp processes left behind by dead fleet agents.
 *
 * A process qualifies only when ALL of these hold (never anything else):
 *   - its executable is locus-mcp (ucomm or argv0 basename)
 *   - its parent is a node process whose own ppid is 1 (orphaned chain)
 *   - it has been alive longer than --min-age (default 12h)
 *   - its own or its node parent's command line carries a path under an
 *     eligible root: a fleet worktree (~/Projects/ashlrai/wt) or
 *     ~/.ashlr-runs, unless overridden with --root
 *
 * Mason's own app-spawned servers (Claude/Cursor under /Applications, bare
 * ~/.locus/bin installs) carry no such path and are never matched.
 *
 * Default is dry-run: a listing (pid, ppid, age, cwd, cmd, plus the node
 * parent) is written to ~/.ashlr-runs/reap-locus-mcp-dryrun.txt. Processes
 * are signaled only with --apply, after a second confirmation scan, parent
 * first so a live agent cannot respawn the server, SIGTERM then SIGKILL.
 */
import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const MIN_AGE_SECONDS = 12 * 60 * 60;
export const DRY_RUN_NAME = 'reap-locus-mcp-dryrun.txt';
export const APPLY_NAME = 'reap-locus-mcp-apply.txt';
const NODE = new Set(['node', 'nodejs']);
const GRACE_MS = 3000;
const USAGE = 'usage: reap-orphan-locus-mcp.mjs [--apply] [--state-dir DIR] [--root PATH]... [--min-age SECONDS]';

export const defaultRoots = (home = homedir()) =>
  [join(home, 'Projects', 'ashlrai', 'wt'), join(home, '.ashlr-runs')].map((p) => resolve(p));

const listProcesses = async () =>
  (await exec('/bin/ps', ['-xww', '-o', 'pid=', '-o', 'ppid=', '-o', 'etime=', '-o', 'ucomm=', '-o', 'command='], { maxBuffer: 16 * 1024 * 1024 })).stdout;

const processCwd = async (pid) => {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-w', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 });
    const line = stdout.split('\n').find((entry) => entry.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch { return null; }
};

/** etime [[dd-]hh:]mm:ss, or plain seconds. */
export function elapsedSeconds(field) {
  if (/^\d+$/.test(field)) return Number(field);
  const match = field.match(/^(?:(\d+)-)?(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0) * 86400;
  return match[4] === undefined
    ? days + Number(match[2]) * 60 + Number(match[3])
    : days + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

export function parsePs(text) {
  const rows = new Map();
  for (const line of String(text).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$/);
    const etimes = match && elapsedSeconds(match[3]);
    if (etimes === null || etimes === undefined) continue;
    rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), etimes, ucomm: match[4], command: match[5] });
  }
  return rows;
}

const argv0 = (command) => basename(command.split(/\s+/, 1)[0] ?? '');
const isLocusMcp = (row) => row.ucomm === 'locus-mcp' || argv0(row.command) === 'locus-mcp';
const isNode = (row) => NODE.has(row.ucomm) || NODE.has(argv0(row.command));

export function referencesRoot(command, roots) {
  for (const token of command.split(/\s+/)) {
    const value = token.slice(token.lastIndexOf('=') + 1);
    if (!value.startsWith('/')) continue;
    const candidate = resolve(value);
    for (const root of roots) if (candidate === root || candidate.startsWith(root + sep)) return true;
  }
  return false;
}

export function selectOrphans(rows, { roots, minAge = MIN_AGE_SECONDS }) {
  const matches = [];
  for (const row of rows.values()) {
    if (!isLocusMcp(row) || row.etimes <= minAge) continue;
    const parent = rows.get(row.ppid);
    if (!parent || parent.ppid !== 1 || !isNode(parent)) continue;
    if (!referencesRoot(row.command, roots) && !referencesRoot(parent.command, roots)) continue;
    matches.push({ process: row, parent });
  }
  return matches.sort((a, b) => a.process.pid - b.process.pid);
}

async function terminate(pid, { signal, sleep, graceMs = GRACE_MS }) {
  const exists = () => { try { signal(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  try { signal(pid, 'SIGTERM'); }
  catch (error) { return { pid, result: error.code === 'ESRCH' ? 'already-gone' : `denied:${error.code ?? 'unknown'}` }; }
  for (const until = Date.now() + graceMs; Date.now() < until && exists();) await sleep(100);
  if (!exists()) return { pid, result: 'terminated' };
  try { signal(pid, 'SIGKILL'); } catch (error) { return { pid, result: error.code === 'ESRCH' ? 'terminated' : `denied:${error.code ?? 'unknown'}` }; }
  await sleep(50);
  return { pid, result: exists() ? 'still-running' : 'terminated' };
}

/** Signal each chain's node parent, then its locus-mcp leaf; each pid once. */
export async function applyOrphans(matches, injected = {}) {
  const deps = { signal: (pid, sig) => process.kill(pid, sig), sleep: delay, ...injected };
  const results = [];
  const seen = new Set();
  for (const { process: leaf, parent } of matches) {
    for (const pid of [parent.pid, leaf.pid]) {
      if (!seen.has(pid)) { seen.add(pid); results.push(await terminate(pid, deps)); }
    }
  }
  return results;
}

function render({ matches, roots, minAge, apply, results, now, scanned }) {
  const lines = [
    `# reap-orphan-locus-mcp ${apply ? 'APPLY' : 'DRY-RUN'} ${(now ?? new Date()).toISOString()}`,
    `# scanned ${scanned} process(es); criteria: executable locus-mcp, age>${minAge}s, node parent with ppid 1, argv path under:`,
    ...roots.map((root) => `#   ${root}`),
  ];
  for (const { process: leaf, parent } of matches) {
    lines.push(`pid=${leaf.pid} ppid=${leaf.ppid} age=${leaf.etimes}s cwd=${leaf.cwd ?? 'unknown'} cmd=${leaf.command}`);
    lines.push(`  parent pid=${parent.pid} ppid=${parent.ppid} age=${parent.etimes}s cmd=${parent.command}`);
  }
  for (const { pid, result } of results ?? []) lines.push(`  signal pid=${pid} result=${result}`);
  lines.push(`# ${matches.length} match(es)`);
  return lines.join('\n') + '\n';
}

export async function run(argv, injected = {}) {
  const home = injected.home ?? homedir();
  const options = { apply: false, stateDir: injected.stateDir ?? join(home, '.ashlr-runs'), roots: [], minAge: MIN_AGE_SECONDS };
  const value = (index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${argv[index]}`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { (injected.log ?? console.log)(USAGE); return { matches: [], results: null, file: null }; }
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--state-dir') { options.stateDir = value(index); index += 1; }
    else if (arg === '--root') { options.roots.push(value(index)); index += 1; }
    else if (arg === '--min-age') { options.minAge = Number(value(index)); index += 1; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  const roots = (options.roots.length ? options.roots : defaultRoots(home)).map((root) => resolve(String(root)));
  for (const root of roots) {
    if (root === sep || root === resolve(home)) throw new Error(`eligible root is too broad: ${root}`);
  }
  if (!options.stateDir || !Number.isFinite(options.minAge) || options.minAge < 0) throw new Error('invalid --state-dir or --min-age');
  options.stateDir = resolve(String(options.stateDir));
  const scan = injected.listProcesses ?? listProcesses;
  const cwdOf = injected.cwdOf ?? processCwd;
  const pick = async () => {
    const table = parsePs(await scan());
    return { table, matches: selectOrphans(table, { roots, minAge: options.minAge }) };
  };
  let { table, matches: confirmed } = await pick();
  let scanned = table.size;
  if (options.apply) {
    // Re-verify against a fresh process table; only chains still matching are signaled.
    ({ table, matches: confirmed } = await pick());
    scanned = table.size;
  }
  for (const { process: leaf } of confirmed) leaf.cwd = await cwdOf(leaf.pid);
  const results = options.apply ? await applyOrphans(confirmed, injected) : null;
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const file = join(options.stateDir, options.apply ? APPLY_NAME : DRY_RUN_NAME);
  const stage = join(options.stateDir, `.reap-locus-mcp.${process.pid}.tmp`);
  await writeFile(stage, render({ matches: confirmed, roots, minAge: options.minAge, apply: options.apply, results, now: injected.now, scanned }), { mode: 0o600 });
  await rename(stage, file);
  (injected.log ?? console.log)(`${options.apply ? 'applied' : 'dry-run'}: ${confirmed.length} match(es), listing ${file}`);
  return { matches: confirmed, results, file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`reap-orphan-locus-mcp: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
  });
}
