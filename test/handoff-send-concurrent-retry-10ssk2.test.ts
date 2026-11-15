import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { renderHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

const handoff: WorkerHandoff = { id: 'TASK-ONE', task: 'Inspect the synthetic task',
  files: [{ path: 'src/example.ts' }], constraints: [], check: 'Verify the result' };
const other: WorkerHandoff = { ...handoff, id: 'TASK-TWO', task: 'Inspect another synthetic task' };

it('retains a handoff across competing process submissions and collision retries', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-race-')));
  const root = join(dir, 'bus'), file = join(dir, 'handoff.json'), childFile = join(dir, 'child.mjs');
  const children: ChildProcess[] = [];
  const output: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  const args = (id: string, apply = true) => ['--file', file, '--id', id, '--from', 'planner', '--to', 'worker',
    ...(apply ? ['--apply'] : []), '--json'];
  const send = async (id: string, apply = true) => {
    const code = await cmdFleetHandoffSend(args(id, apply), { root });
    return { code, receipt: JSON.parse(output.at(-1)!) as { status: string } };
  };
  try {
    writeFileSync(file, JSON.stringify(handoff));
    expect(await send('message-1', false)).toMatchObject({ code: 0, receipt: { status: 'preview' } });
    expect(existsSync(root)).toBe(false);
    mkdirSync(join(root, 'bus-inbox'), { recursive: true, mode: 0o700 });
    const moduleUrl = new URL('../src/cli/fleet-handoff-send.ts', import.meta.url).href;
    writeFileSync(childFile, `import { cmdFleetHandoffSend } from ${JSON.stringify(moduleUrl)};\n` +
      `process.send('ready'); process.once('message', async ({ args, root }) => {\n` +
      `let output = ''; console.log = value => { output = String(value); };\n` +
      `const code = await cmdFleetHandoffSend(args, { root }); process.send({ code, receipt: JSON.parse(output) }); });\n`);
    const runChild = () => {
      const child = fork(childFile, [], { execArgv: ['--import', 'tsx'], env: { HOME: dir, PATH: process.env.PATH },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      return new Promise<{ code: number; receipt: { status: string; cursor?: number } }>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => { if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`)); });
        child.on('message', message => {
          if (message === 'ready') { ready(); return; }
          resolve(message as { code: number; receipt: { status: string; cursor?: number } });
          child.disconnect();
        });
      });
    };
    let readyCount = 0;
    const ready = () => {
      if (++readyCount === 2) for (const child of children) child.send({ args: args('message-1'), root });
    };
    const results = await Promise.all([runChild(), runChild()]);
    expect(results.filter(result => result.receipt.status === 'posted')).toHaveLength(1);
    expect(results.map(result => result.code).sort()).toEqual(
      results.some(result => result.receipt.status === 'retryable') ? [0, 1] : [0, 0]);
    expect(results.map(result => result.receipt.status).sort()).toEqual(
      results.some(result => result.receipt.status === 'retryable') ? ['posted', 'retryable'] : ['duplicate', 'posted']);
    expect(await send('message-1')).toMatchObject({ code: 0, receipt: { status: 'duplicate', cursor: 1 } });
    const read = () => {
      const page = listBusInboxAfter(0, 50, { root });
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') throw new Error('inbox unavailable');
      return page.messages.map(row => row.envelope);
    };
    const original = { id: 'message-1', from: 'planner', to: 'worker', body: {
      kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) } };
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject(original);
    writeFileSync(file, JSON.stringify(other));
    expect(await send('message-1')).toEqual({ code: 1, receipt: { v: 1, status: 'conflict' } });
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject(original);
    expect(await send('message-2')).toMatchObject({ code: 0, receipt: { status: 'posted', cursor: 2 } });
    expect(read()).toMatchObject([original, { id: 'message-2', from: 'planner', to: 'worker', body: {
      kind: 'worker-handoff', taskId: other.id, prompt: renderHandoff(other) } }]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
