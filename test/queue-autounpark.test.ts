import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cmdQueue } from '../src/cli/queue.js';

const helper = resolve('contrib/mac/queue_autounpark.py');
let home: string;
let queue: string;
let env: NodeJS.ProcessEnv;
const originalHome = process.env['HOME'];
function python(code: string) {
  return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(resolve('contrib/mac'))}); import queue_autounpark as q; from pathlib import Path; root=Path.home()/'.ashlr-runs/queue'; ${code}`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function parked(tier = 'work', body = 'DEPENDENCY GATE: RQ-A, RQ-B MERGED\nDEPENDENCY GATE: RQ-C MERGED\n') {
  const prompt = join(queue, 'prompt.md');
  writeFileSync(prompt, body);
  writeFileSync(join(queue, 'parked.tsv'), `RQ-JOB\tphantom\tcodex-personal\t${tier}\t${prompt}\tpin=1\n`);
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'queue-autounpark-'));
  queue = join(home, '.ashlr-runs/queue');
  mkdirSync(queue, { recursive: true });
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
if args[:2]==['pr','list']:
 if 'merged' in args:
  search=args[args.index('--search')+1]
  dep=search.split()[0].removeprefix('head:codex-bridge/')
  rows=[] if dep==os.environ.get('UNMERGED') else [{'number':1,'headRefName':'codex-bridge/'+dep,'title':'Dependency work','mergedAt':'2026-11-04T00:00:00Z'}]
  print(json.dumps(rows if search.startswith('head:') else []))
 else: print('[]')
elif 'graphql' in args: print(json.dumps({'data':{'repository':{'mergeQueue':{'entries':{'totalCount':0}}}}}))
else: print(json.dumps({'total_count':3,'runners':[{'status':'online','busy':False}]*3}))
`, { mode: 0o755 });
  env = { ...process.env, HOME: home, PATH: `${bin}:${process.env['PATH']}` };
  process.env['HOME'] = home;
  writeFileSync(join(queue, 'ready.tsv'), 'EXISTING\tphantom\tcodex-personal\twork\t/existing\n');
  parked();
});
afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('Mac queue automatic unpark', () => {
  it('promotes all merged dependencies across every gate and preserves pin and prompt', () => {
    python('q.promote(root)');
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8')).toContain('RQ-JOB\tphantom\tcodex-personal\twork');
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8')).toContain('\tpin=1\n');
    expect(readFileSync(join(queue, 'parked.tsv'), 'utf8')).toBe('');
    expect(readFileSync(join(queue, 'prompt.md'), 'utf8')).toContain('DEPENDENCY GATE: RQ-C MERGED');
    expect(readFileSync(join(queue, 'unpark.log'), 'utf8')).toContain('UNPARK RQ-JOB deps=RQ-A,RQ-B,RQ-C');
  });
  it('keeps the row parked when one dependency is unmerged', () => {
    env['UNMERGED'] = 'RQ-C';
    python('q.promote(root)');
    expect(readFileSync(join(queue, 'parked.tsv'), 'utf8')).toContain('RQ-JOB');
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8')).not.toContain('RQ-JOB');
  });
  it('writes an exact timestamped ready backup before promotion', () => {
    const before = readFileSync(join(queue, 'ready.tsv'), 'utf8');
    python('q.promote(root)');
    const backup = readdirSync(queue).find(name => /^ready.tsv.bak-autounpark-\d{8}-\d{6}$/.test(name));
    expect(backup).toBeDefined();
    expect(readFileSync(join(queue, backup!), 'utf8')).toBe(before);
  });
  it('acquires ready.lock and refuses to mutate while another writer holds it', async () => {
    const child = spawn('python3', ['-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(10)', join(queue, 'ready.lock')]);
    try {
      await new Promise<void>((resolveReady, reject) => { child.stdout.once('data', () => resolveReady()); child.once('error', reject); });
      env['ASHLR_READY_LOCK_TIMEOUT'] = '0.1';
      expect(() => python('q.promote(root)')).toThrow();
      expect(readFileSync(join(queue, 'ready.tsv'), 'utf8')).not.toContain('RQ-JOB');
    } finally { child.kill(); }
  });
  it('rejects invalid tiers to unpark.log', () => {
    parked('standard');
    python('q.promote(root)');
    expect(readFileSync(join(queue, 'unpark.log'), 'utf8')).toContain('REJECT RQ-JOB invalid tier');
    expect(readFileSync(join(queue, 'parked.tsv'), 'utf8')).toContain('RQ-JOB');
  });
  it('keeps adaptive cap at least two under saturated or unavailable runners', () => {
    expect(python('print([q.adaptive_cap(20, 0), q.adaptive_cap(3, 4), q.adaptive_cap(1, 8)])').trim()).toBe('[2, 2, 7]');
  });
  it('holds capacity overflow in parked order and leaves ready order intact', () => {
    const row = readFileSync(join(queue, 'parked.tsv'), 'utf8');
    writeFileSync(join(queue, 'parked.tsv'), row + row.replace('RQ-JOB\t', 'RQ-NEXT\t') + row.replace('RQ-JOB\t', 'RQ-LAST\t'));
    python('q.promote(root)');
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8').split('\n').slice(0, 3).map(line => line.split('\t')[0])).toEqual(['EXISTING', 'RQ-JOB', 'RQ-NEXT']);
    expect(readFileSync(join(queue, 'parked.tsv'), 'utf8').startsWith('RQ-LAST\t')).toBe(true);
  });
  it('dry-run reports promotion without creating backups, locks or logs', () => {
    const before = readdirSync(queue);
    const output = execFileSync('python3', ['-I', helper, 'dry-run'], { env, encoding: 'utf8' });
    expect(JSON.parse(output).promote).toEqual(['RQ-JOB']);
    expect(readdirSync(queue)).toEqual(before);
  });
  it('fails closed on missing prompts, malformed gates and unavailable gh', () => {
    parked('work', 'DEPENDENCY GATE: RQ-A\n');
    expect(JSON.parse(python('import json; print(json.dumps(q.plan(root)))')).promote).toEqual([]);
    rmSync(join(queue, 'prompt.md'));
    expect(JSON.parse(python('import json; print(json.dumps(q.plan(root)))')).promote).toEqual([]);
    parked();
    writeFileSync(join(home, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(JSON.parse(python('import json; print(json.dumps(q.plan(root)))')).promote).toEqual([]);
  });
  it('runs automatic promotion even without an author queue', () => {
    execFileSync('python3', ['-B', resolve('contrib/mac/restock.py'), '--json'], { env, encoding: 'utf8' });
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8')).toContain('RQ-JOB');
    expect(readFileSync(join(queue, 'parked.tsv'), 'utf8')).toBe('');
  });
  it('releases merge-capacity parking without dependency gates', () => {
    parked('work', 'Wait for merge capacity.\nno merge without Security pin\n');
    python('q.promote(root)');
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8')).toContain('RQ-JOB');
    expect(readFileSync(join(queue, 'prompt.md'), 'utf8')).toContain('no merge without Security pin');
  });
  it('retains cap overflow in the author queue without changing ready order', () => {
    writeFileSync(join(queue, 'parked.tsv'), '');
    mkdirSync(join(queue, 'prompts'));
    mkdirSync(join(home, 'Projects/ashlrai/phantom'), { recursive: true });
    writeFileSync(join(queue, 'slots.json'), JSON.stringify({
      'codex-cmp': { held: true }, devin: { held: true }, 'codex-local': { held: true },
      'claude-api': { target: 0 }, 'codex-personal': { target: 3 },
    }));
    const rows = ['RQ-FIRST', 'RQ-SECOND', 'RQ-THIRD'].map(id =>
      `- READY ${id} (P1, pool=codex-personal, tier=work, repo=phantom): repair this job`);
    writeFileSync(join(queue, 'router-queue.md'), rows.join('\n') + '\n');
    const output = execFileSync('python3', ['-B', resolve('contrib/mac/restock.py'), '--json'], { env, encoding: 'utf8' });
    expect(JSON.parse(output).skips['merge-cap']).toBe(1);
    expect(readFileSync(join(queue, 'router-queue.md'), 'utf8')).toContain(rows[2]);
    expect(readFileSync(join(queue, 'ready.tsv'), 'utf8').split('\n').slice(0, 3).map(line => line.split('\t')[0]))
      .toEqual(['EXISTING', 'RQ-FIRST', 'RQ-SECOND']);
  });
  it('routes read-only CLI verbs and requires dry-run for unpark', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Invalid rows need no gh lookup, keeping this CLI smoke test offline.
    parked('invalid');
    expect(await cmdQueue(['parked', '--json'])).toBe(0);
    expect(await cmdQueue(['unpark', '--dry-run', '--json'])).toBe(0);
    expect(await cmdQueue(['unpark', '--json'])).toBe(2);
    expect(readdirSync(queue)).not.toContain('ready.lock');
  });
});
