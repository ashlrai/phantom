/**
 * Fleet graph argv runs own each node's process group on POSIX: a deadline or
 * a SIGINT/SIGTERM cancel must stop the WHOLE tree before the runner returns,
 * not just the direct child. Before the group was owned, stop() signalled only
 * the leader — a grandchild that kept the inherited stdout/stderr pipes (or
 * swallowed SIGTERM) survived as an orphan, and because 'close' waits on those
 * pipes the run itself could hang past its own deadline.
 *
 * These tests spawn a real Node child that forks a real grandchild holding the
 * pipes, then stop it by deadline and by SIGTERM. POSIX process groups are
 * required for the group-kill assertions; the portable rows (success, spawn
 * failure, blocked descendants, preview) run everywhere. Every pid a child
 * writes is SIGKILLed in afterEach so no descendant survives a failed
 * assertion.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun } from '../src/core/fleet/graph-argv-run.js';

const POSIX = process.platform !== 'win32';
let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-tree-stop-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  for (const name of readdirSync(dir).filter(n => /\.g?pid$/.test(n))) {
    const pid = Number(readFileSync(join(dir, name), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    // Leaders are group leaders: sweep the group too so no member of a tree
    // the test spawned outlives it, even if an assertion failed mid-run.
    if (POSIX) { try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ } }
  }
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const path = (name: string) => JSON.stringify(join(dir, name));
const argv = (code: string) => [process.execPath, '-e', `const fs=require('node:fs');${code}`];
const touch = (name: string) => `fs.writeFileSync(${path(name)},'ok');`;
function graph(tasks: unknown[]) {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}
async function waitFor(name: string) {
  const deadline = Date.now() + 15000;
  while (!existsSync(join(dir, name))) {
    if (Date.now() > deadline) throw Error(`missing ${name}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function pidOf(name: string): number {
  const pid = Number(readFileSync(join(dir, name), 'utf8').trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  return pid;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// A killed descendant can sit as an unreaped zombie until init collects it —
// poll the probe instead of asserting on a single kill(pid, 0).
async function waitDead(pid: number, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}
/** A leader that spawns a grandchild which KEEPS the inherited stdio pipes
 * (stdio:'inherit') and ignores SIGTERM, records both pids itself (recording
 * g.pid here, not in the grandchild, keeps the file deterministic even when
 * the sweep kills the grandchild before it finishes booting), then either
 * idles ignoring SIGTERM or exits immediately leaving the straggler behind. */
const stubbornTree = (name: string, leader: 'linger' | 'exit' = 'linger', detached = false) => argv(`
  const cp=require('node:child_process');
  const g=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],{stdio:'inherit',detached:${detached}});
  g.unref();
  fs.writeFileSync(${path(`${name}.gpid`)},String(g.pid));
  fs.writeFileSync(${path(`${name}.pid`)},String(process.pid));
  ${leader === 'linger' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : 'process.exit(0);'}
`);

it.runIf(POSIX)('the shared deadline kills a TERM-ignoring leader and its pipe-holding grandchild as one group', async () => {
  const file = graph([
    { id: 'A', argv: stubbornTree('A') },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('B')) },
  ]);
  const started = Date.now();
  const running = graphArgvRun(file, true, 3000);
  await Promise.all([waitFor('A.pid'), waitFor('A.gpid')]);
  const r = await running;
  // The deadline fires once; TERM then KILL ends the whole group shortly
  // after it. The old per-child kill left the grandchild (and its pipes)
  // running forever.
  expect(Date.now() - started).toBeLessThan(15000);
  expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'deadline-exhausted']);
  expect(existsSync(join(dir, 'B'))).toBe(false);
  expect(await waitDead(pidOf('A.pid'))).toBe(true);
  expect(await waitDead(pidOf('A.gpid'))).toBe(true);
});

it.runIf(POSIX)('SIGTERM cancellation stops the group before the runner returns; a repeated stop is harmless', async () => {
  const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
  const file = graph([
    { id: 'A', argv: stubbornTree('A') },
    { id: 'B', argv: argv(touch('B')) },
  ]);
  const running = graphArgvRun(file, true, 30000);
  await Promise.all([waitFor('A.pid'), waitFor('A.gpid')]);
  const stoppedAt = Date.now();
  process.emit('SIGTERM');
  process.emit('SIGTERM'); // a second stop must not wedge or re-arm the run
  const r = await running;
  expect(Date.now() - stoppedAt).toBeLessThan(10000);
  expect(r.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled']);
  expect(existsSync(join(dir, 'B'))).toBe(false);
  expect(await waitDead(pidOf('A.pid'))).toBe(true);
  expect(await waitDead(pidOf('A.gpid'))).toBe(true);
  expect(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s))).toEqual(before);
});

it.runIf(POSIX)('a leader that exits before its descendants still leaves nothing running in the group', async () => {
  const file = graph([
    { id: 'A', argv: stubbornTree('A', 'exit') },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('B')) },
  ]);
  const started = Date.now();
  const r = await graphArgvRun(file, true, 30000);
  // The leader's exit is swept: the straggler holding our pipes is killed
  // instead of stalling 'close', so A completes on time and B still runs.
  expect(Date.now() - started).toBeLessThan(15000);
  expect(r.nodes.map(n => n.status)).toEqual(['success', 'success']);
  expect(existsSync(join(dir, 'B'))).toBe(true);
  expect(await waitDead(pidOf('A.gpid'))).toBe(true);
});

it.runIf(POSIX)('a descendant outside the group holding a pipe cannot stall the run past the settle bound', async () => {
  // detached:true puts the grandchild in its OWN group — kill(-pgid) must
  // never reach it. It still holds our pipes, so only the bounded settle
  // (drop the local ends, release the handle) lets the run return.
  const file = graph([
    { id: 'A', argv: stubbornTree('A', 'linger', true) },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('B')) },
  ]);
  const started = Date.now();
  const running = graphArgvRun(file, true, 3000);
  await Promise.all([waitFor('A.pid'), waitFor('A.gpid')]);
  const r = await running;
  expect(Date.now() - started).toBeLessThan(15000);
  expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'deadline-exhausted']);
  expect(await waitDead(pidOf('A.pid'))).toBe(true);
  // The escapee is outside the owned group: it must NOT have been signalled
  // (afterEach cleans it up). Group-kill reached exactly the node's own tree.
  expect(alive(pidOf('A.gpid'))).toBe(true);
});

it('normal completion, a spawn failure and a blocked descendant stay correct', async () => {
  const file = graph([
    { id: 'ok', argv: argv(touch('ok')) },
    { id: 'bad', argv: [join(dir, 'no-such-binary-nov01'), 'x'] },
    { id: 'later', dependsOn: ['bad'], argv: argv(touch('later')) },
  ]);
  const r = await graphArgvRun(file, true, 30000, 2);
  const byId = new Map(r.nodes.map(n => [n.id, n.status]));
  expect(byId.get('ok')).toBe('success');
  expect(byId.get('bad')).toBe('failed');
  expect(byId.get('later')).toBe('blocked');
  expect(existsSync(join(dir, 'later'))).toBe(false);
  expect((await graphArgvRun(file, false, 1000)).status).toBe('preview');
});
