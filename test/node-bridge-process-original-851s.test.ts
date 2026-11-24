import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DriveNodes, LocalNodesStore } from '../src/core/drive/nodes/index.js';
import { bridgeLeaseOwner, type NodeBridgeReport } from '../src/core/drive/nodes/ready-bridge.js';

const JOB = 'RQ-REVIEW-PROCESSES';
const OWNER = 'fixture-owner';

function deadline<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

it('claims exactly once across two real bridge processes sharing ASHLR_HOME', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-bridge-process-')));
  const host = { runsRoot: join(root, 'runs'), wtRoot: join(root, 'wt') };
  const home = join(root, 'ashlr');
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  try {
    for (const dir of ['queue/run', 'queue/batches', 'queue/prompts', 'bin']) mkdirSync(join(host.runsRoot, dir), { recursive: true });
    copyFileSync(resolve('contrib/mac/dispatchd.py'), join(host.runsRoot, 'bin', 'dispatchd.py'));
    const prompt = join(host.runsRoot, 'queue', 'prompts', `${JOB}.md`);
    writeFileSync(prompt, '# Fixture\nBounded fake task.\n');
    writeFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), [JOB, 'phantom', 'codex-cmp', 'work', prompt].join('\t') + '\n');
    mkdirSync(join(home, 'nodes'), { recursive: true, mode: 0o700 });
    const nodes = new DriveNodes(new LocalNodesStore(join(home, 'nodes')));
    expect(nodes.join('fixture-worker', { owners: [OWNER], caps: ['codex', 'pack:codex-file'], slots: 2 })).not.toBeNull();
    const code = `
      const { DriveNodes, LocalNodesStore } = require('./src/core/drive/nodes/index.ts');
      const { runNodeBridge, localBridgeRouter } = require('./src/core/drive/nodes/ready-bridge.ts');
      const { join } = require('node:path');
      process.stdin.once('data', async () => {
        try {
          const nodes = new DriveNodes(new LocalNodesStore(join(process.env.ASHLR_HOME, 'nodes')));
          const report = await runNodeBridge({ host: ${JSON.stringify(host)}, router: localBridgeRouter(nodes, ${JSON.stringify(root)}),
            owner: ${JSON.stringify(OWNER)}, apply: true, now: Date.now() });
          console.log(JSON.stringify(report));
        } catch (error) { console.error(error); process.exitCode = 1; }
        process.stdin.destroy();
      });
      console.log('ready');
    `;
    const processes = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--eval', code], {
        cwd: resolve('.'), env: { ...process.env, ASHLR_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      let stdout = '';
      let stderr = '';
      let signalReady!: () => void;
      const ready = new Promise<void>(done => { signalReady = done; });
      child.stdout!.on('data', chunk => { stdout += chunk.toString(); if (stdout.includes('ready\n')) signalReady(); });
      child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
      const result = new Promise<NodeBridgeReport>((done, fail) => {
        child.once('error', fail);
        child.once('close', status => {
          if (status !== 0) { fail(new Error(`bridge exited ${status}: ${stderr}`)); return; }
          try { done(JSON.parse(stdout.trim().split('\n').at(-1)!)); } catch (error) { fail(error); }
        });
      });
      exits.push(new Promise(done => { child.once('close', () => done()); }));
      return { child, ready: Promise.race([ready, result.then(() => { throw new Error('bridge exited before start'); })]), result };
    });
    await deadline(Promise.all(processes.map(p => p.ready)), 'child readiness');
    for (const p of processes) p.child.stdin!.end('go\n');
    const reports = await deadline(Promise.all(processes.map(p => p.result)), 'bridge completion');
    expect(reports.flatMap(r => r.claimed)).toEqual([JOB]);
    expect(reports.flatMap(r => r.requeued)).toEqual([]);
    expect(nodes.view([OWNER]).jobs).toEqual([expect.objectContaining({ id: `ready:${JOB}:1`, state: 'pending' })]);
    expect(readFileSync(join(host.runsRoot, 'queue', 'ready.tsv'), 'utf8')).toBe('');
    expect(readFileSync(join(host.runsRoot, 'queue', 'run', `${JOB}.batched`), 'utf8')).toBe(bridgeLeaseOwner(JOB));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await deadline(Promise.all(exits), 'child cleanup');
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
