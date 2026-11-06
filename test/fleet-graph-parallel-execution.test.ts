import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun } from '../src/core/fleet/graph-argv-run.js';
import { cmdFleetGraphRun } from '../src/cli/fleet-graph-run.js';
let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-parallel-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
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
it('rendezvous proves overlap; default concurrency stays serial', async () => {
  const tasks = ['A', 'B'].map((id, i) => ({ id, argv: argv(`${touch(id)}
    const deadline=Date.now()+5000; const t=setInterval(()=>{
      if(fs.existsSync(${path(i ? 'A' : 'B')})){clearInterval(t);process.exit(0)}
      if(Date.now()>deadline){clearInterval(t);process.exit(9)}
    },10);`) }));
  const file = graph(tasks);
  expect((await graphArgvRun(file, true, 20000, 2)).nodes.map(n => n.status)).toEqual(['success', 'success']);
  rmSync(join(dir, 'A')); rmSync(join(dir, 'B'));
  expect((await graphArgvRun(file, true, 20000)).nodes.map(n => n.exitCode)).toEqual([9, 0]);
});
it('bounds active children and unlocks a branch without a batch barrier', async () => {
  const file = graph([
    { id: 'A', argv: argv(touch('A')) },
    { id: 'slow', argv: argv(`${touch('slow')}const deadline=Date.now()+15000;const t=setInterval(()=>{
      if(fs.existsSync(${path('child')})){${touch('slow-done')}clearInterval(t)}
      else if(Date.now()>deadline)process.exit(8);
    },10);`) },
    { id: 'child', dependsOn: ['A'], argv: argv(`if(fs.existsSync(${path('slow-done')}))process.exit(7);${touch('child')}`) },
    { id: 'queued', argv: argv(`if(!fs.existsSync(${path('A')}))process.exit(6);${touch('queued')}`) },
  ]);
  expect((await graphArgvRun(file, true, 20000, 2)).nodes.map(n => n.status)).toEqual(['success', 'success', 'success', 'success']);
});
it('never exceeds the requested capacity', async () => {
  const file = graph(['A', 'B', 'C'].map(id => ({ id, argv: argv(`
    let slot;for(const p of [${path('slot1')},${path('slot2')}]){try{fs.mkdirSync(p);slot=p;break}catch{}}
    if(!slot)process.exit(9);${touch(id)}
    const deadline=Date.now()+15000; const t=setInterval(()=>{
      if(fs.existsSync(${path('release')})){fs.rmdirSync(slot);clearInterval(t);}
      else if(Date.now()>deadline)process.exit(8);
    },10);`) })));
  const running = graphArgvRun(file, true, 20000, 2);
  try {
    await Promise.all([waitFor('A'), waitFor('B')]);
    expect(existsSync(join(dir, 'C'))).toBe(false);
  } finally { writeFileSync(join(dir, 'release'), ''); }
  expect((await running).nodes.every(n => n.status === 'success')).toBe(true);
});
it('keeps topological ordering and blocks failed descendants', async () => {
  const r = await graphArgvRun(graph([
    { id: 'A', argv: argv('process.exit(7)') },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('blocked')) },
    { id: 'C', argv: argv(touch('independent')) },
  ]), true, 20000, 2);
  expect(r.nodes.map(n => [n.id, n.status])).toEqual([['A', 'failed'], ['C', 'success'], ['B', 'blocked']]);
  expect(existsSync(join(dir, 'blocked'))).toBe(false);
});
it('validates CLI flags, concurrency and the entire graph before preview or apply', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = graph([{ id: 'A', argv: argv(touch('marker')) }]);
  for (const value of ['0', '9', '1.5', '-1', 'no', '']) {
    expect(await cmdFleetGraphRun(['--file', file, '--apply', '--concurrency', value])).toBe(2);
  }
  expect(await cmdFleetGraphRun(['--file', file, '--concurrency', '2', '--concurrency', '2'])).toBe(2);
  expect(await cmdFleetGraphRun(['--file', file, '--apply', '--apply'])).toBe(2);
  expect(await cmdFleetGraphRun(['--file', file, '--concurrency', '2'])).toBe(0);
  expect((await graphArgvRun(file, false, 2000, 1.5)).status).toBe('invalid');
  expect((await graphArgvRun(graph([{ id: 'A', argv: argv(touch('marker')) }, { id: 'late', argv: [] }]), true, 20000, 2)).status).toBe('invalid');
  expect(existsSync(join(dir, 'marker'))).toBe(false);
});
it.each(['PAUSE', 'ORCH_OFF', 'HOLD'])('a %s change prevents newly eligible starts', async control => {
  const r = await graphArgvRun(graph([
    { id: 'A', argv: argv(touch(control)) },
    { id: 'B', dependsOn: ['A'], argv: argv(touch('blocked')) },
  ]), true, 20000, 2);
  expect(r.nodes.map(n => n.status)).toEqual(['success', 'refused']);
  expect(existsSync(join(dir, 'blocked'))).toBe(false);
});
it('cancels and reaps both active children, leaves queued work and restores listeners', async () => {
  const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
  const file = graph(['A', 'B', 'queued'].map(id => ({ id, argv: argv(`process.on('SIGTERM',()=>{});fs.writeFileSync(${path(id)},String(process.pid));setInterval(()=>{},1000);`) })));
  const running = graphArgvRun(file, true, 20000, 2);
  try { await Promise.all([waitFor('A'), waitFor('B')]); }
  finally { process.emit('SIGTERM'); }
  const r = await running;
  expect(r.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  for (const id of ['A', 'B']) expect(() => process.kill(Number(readFileSync(join(dir, id), 'utf8')), 0)).toThrow();
  expect(existsSync(join(dir, 'queued'))).toBe(false);
  expect(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s))).toEqual(before);
});
it('timeout frees capacity and blocks descendants', async () => {
  const r = await graphArgvRun(graph([
    { id: 'timeout', argv: argv('setInterval(()=>{},1000)') },
    { id: 'independent', argv: argv(touch('independent')) },
    { id: 'blocked', dependsOn: ['timeout'], argv: argv(touch('blocked')) },
  ]), true, 5000, 1);
  expect(r.nodes.map(n => n.status)).toEqual(['timeout', 'success', 'blocked']);
  expect(existsSync(join(dir, 'independent'))).toBe(true);
  expect(existsSync(join(dir, 'blocked'))).toBe(false);
});
