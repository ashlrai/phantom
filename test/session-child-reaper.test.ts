import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { spawnSessionChild, sessionChildPids } from '../src/core/verse/process-registry.js';
import { processIsRunning, waitForProcessExit } from './helpers/process-liveness.js';

const children: ChildProcess[] = [];
const groups = new Set<number>();
const moduleUrl = new URL('../src/core/verse/process-registry.ts', import.meta.url).href;
const tsxUrl = import.meta.resolve('tsx');

// These inert fixtures never invoke vendor agents or external services.
const stubbornTree = String.raw`
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
console.log(JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;

async function firstLine(child: ChildProcess): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('fixture readiness deadline exceeded')), 4_000);
    child.once('error', reject);
    child.stdout!.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
    });
    child.stderr?.on('data', () => {});
  });
}

async function launchParent(): Promise<{ parent: ChildProcess; pid: number; pids: number[] }> {
  const script = `
    import { spawnSessionChild, sessionChildPids } from ${JSON.stringify(moduleUrl)};
    const child = spawnSessionChild(process.execPath, ['-e', ${JSON.stringify(stubbornTree)}],
      { stdio: ['ignore', 'pipe', 'pipe'] }, 'fixture-session');
    child.stdout.once('data', data => {
      const row = JSON.parse(String(data));
      setImmediate(() => console.log(JSON.stringify({ ...row, tracked: sessionChildPids('fixture-session')[0],
        watchdog: sessionChildPids('fixture-session').find(pid => pid !== child.pid) })));
    });
    child.stderr.on('data', () => {});
  `;
  const parent = spawn(process.execPath, ['--import', tsxUrl, '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
  });
  children.push(parent);
  const row = await firstLine(parent);
  expect(row.tracked).toBe(row.pid);
  groups.add(row.pid);
  const pids = [row.pid, row.grandchild, row.watchdog];
  // The executable, its grandchild, and the group-anchoring watchdog.
  expect(pids).toContain(row.pid);
  expect(pids).toContain(row.grandchild);
  expect(row.watchdog).toBeGreaterThan(1);
  return { parent, pid: row.pid, pids };
}

afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  for (const pgid of groups) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  groups.clear();
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('session child orphan guard', () => {
  it('reaps a group when Phantom dies before the executable reports readiness', async () => {
    const source = `
      import { spawnSessionChild, sessionChildPids } from ${JSON.stringify(moduleUrl)};
      const child = spawnSessionChild(process.execPath, ['-e', 'setTimeout(() => console.log("ready"), 10000)'],
        { stdio: 'ignore' }, 'startup-death');
      child.stdio[3].once('data', () => console.log(JSON.stringify({ pid: child.pid,
        watchdog: sessionChildPids('startup-death').find(pid => pid !== child.pid) })));
    `;
    const parent = spawn(process.execPath, ['--import', tsxUrl, '--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(parent);
    const { pid, watchdog } = await firstLine(parent);
    expect(watchdog).toBeGreaterThan(1);
    groups.add(pid);
    parent.kill('SIGKILL');
    expect(await waitForProcessExit([pid, watchdog], { timeoutMs: 2_000 })).toBe(true);
  });

  it('reaps every agent, descendant and watchdog after the Phantom parent is SIGKILLed', async () => {
    const { parent, pids } = await launchParent();
    parent.kill('SIGKILL');
    expect(await waitForProcessExit(pids, { timeoutMs: 2_000 })).toBe(true);
  });

  it('cleans on orderly parent exit and leaves another session running', async () => {
    const first = await launchParent();
    const second = await launchParent();
    first.parent.kill('SIGTERM');
    expect(await waitForProcessExit(first.pids, { timeoutMs: 2_000 })).toBe(true);
    expect(second.pids.every(processIsRunning)).toBe(true);
    second.parent.kill('SIGKILL');
    expect(await waitForProcessExit(second.pids, { timeoutMs: 2_000 })).toBe(true);
  });

  it.each([0, 17])('preserves natural exit code %i and reaps descendants after leader exit', async code => {
    const child = spawnSessionChild(process.execPath, ['-e', stubbornTree.replace('setInterval(() => {}, 1000);', `setTimeout(() => process.exit(${code}), 100);`)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }, 'natural-exit');
    children.push(child);
    groups.add(child.pid!);
    const closed = once(child, 'close');
    const row = await firstLine(child);
    expect(row.pid).toBe(child.pid);
    const pids = [...sessionChildPids('natural-exit'), row.grandchild];
    expect(await closed).toEqual([code, null]);
    expect(sessionChildPids('natural-exit')).toEqual([]);
    expect(await waitForProcessExit(pids)).toBe(true);
  });

  it('retains errno startup failures and forgets failed sessions', async () => {
    const child = spawnSessionChild('/nonexistent/phantom-fixture-agent', [], { stdio: ['ignore', 'pipe', 'pipe'] }, 'missing');
    children.push(child);
    const error = await new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
    expect(error.code).toBe('ENOENT');
    expect(sessionChildPids('missing')).toEqual([]);
    expect(await waitForProcessExit(child.pid!)).toBe(true);
  });

  it('passes stdin/stdout and restores the requested environment without bootstrap metadata', async () => {
    const child = spawnSessionChild(process.execPath, ['-e', `
      process.stdin.once('data', data => console.log(JSON.stringify({
        data: Number(String(data)), metadata: Object.keys(process.env).filter(k => k.startsWith('ASHLR_CHILD_')).length,
        option: Number(process.env.NODE_OPTIONS === '--no-warnings'),
        shellEnv: Number(process.env.SHLVL === '7' && process.env.PWD === '/synthetic/workspace' && process.env._ === 'fixture')
      })));
    `], { stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, NODE_OPTIONS: '--no-warnings', SHLVL: '7', PWD: '/synthetic/workspace', _: 'fixture',
    } }, 'streams');
    children.push(child);
    const closed = once(child, 'close');
    const ready = firstLine(child);
    child.stdin!.end('42');
    expect(await ready).toEqual({ data: 42, metadata: 0, option: 1, shellEnv: 1 });
    expect(await closed).toEqual([0, null]);
  });

  it('keeps shell metacharacters literal and refuses executable assignment operands', async () => {
    expect(() => spawnSessionChild('worker=fixture', [process.execPath], {}, 'invalid-command'))
      .toThrow('Executable names containing =');
    const literal = '$(exit 91); `exit 92` "single\'quote"';
    const child = spawnSessionChild(process.execPath, ['-e', 'console.log(JSON.stringify({ literal: Number(process.argv[1] === process.env.EXPECTED) }))', literal], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { EXPECTED: literal },
    }, 'literal-argv');
    children.push(child);
    const closed = once(child, 'close');
    expect(await firstLine(child)).toEqual({ literal: 1 });
    expect(await closed).toEqual([0, null]);
  });
});
