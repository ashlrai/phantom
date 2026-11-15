import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { renderHandoff } from '../src/core/verse/handoff.js';

it('cancels incomplete piped handoffs in a child and accepts a later complete send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-process-'));
  const root = join(dir, 'bus'), stage = join(dir, 'stage'), childFile = join(dir, 'child.mjs');
  const children: ChildProcess[] = [];
  const handoff = { id: 'WORK-PROCESS-114', task: 'Synthetic text; $(not a command)',
    files: [{ path: 'src/example.ts' }], constraints: [], check: 'Check synthetic result' };
  mkdirSync(stage);
  const moduleUrl = new URL('../src/cli/fleet-handoff-pipe.ts', import.meta.url).href;
  writeFileSync(childFile, `import { cmdFleetHandoffPipe } from ${JSON.stringify(moduleUrl)};\n` +
    `process.stdin.once('data', () => { process.send('reading'); process.disconnect(); });\n` +
    `process.exitCode = await cmdFleetHandoffPipe(JSON.parse(process.argv[2]), ` +
    `{ root: ${JSON.stringify(root)}, tempRoot: ${JSON.stringify(stage)} });\n`);
  const run = async (id: string, mode: 'SIGINT' | 'SIGTERM' | 'timeout' | 'complete' | 'preview') => {
    const args = ['--stdin', '--id', id, '--from', 'planner-fake', '--to', 'worker-fake', '--json',
      '--input-timeout-ms', mode === 'timeout' ? '250' : '5000',
      ...(mode === 'preview' ? [] : ['--apply'])];
    const child = fork(childFile, [JSON.stringify(args)], { execArgv: ['--import', 'tsx'],
      env: { PATH: process.env.PATH, HOME: dir, ASHLR_HOME: join(dir, 'ashlr'),
        ASHLR_RUNS_DIR: join(dir, 'runs'), TMPDIR: dir }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', message => message === 'reading' ? resolve() : reject(new Error('unexpected handshake')));
        child.once('exit', () => reject(new Error('child exited before handshake')));
      });
      child.stdin!.write(mode === 'complete' || mode === 'preview' ? JSON.stringify(handoff) : '{"id":"partial');
      await ready;
      if (mode === 'SIGINT' || mode === 'SIGTERM') child.kill(mode);
      if (mode === 'complete' || mode === 'preview') child.stdin!.end();
      const exit = await result;
      expect(stderr).toBe('');
      const lines = stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      return { ...exit, receipt: JSON.parse(lines[0]!) };
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await result;
    }
  };
  const inbox = () => {
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('inbox unavailable');
    return page.messages;
  };
  try {
    for (const [mode, code, detail] of [
      ['SIGINT', 130, 'input interrupted'], ['SIGTERM', 143, 'input terminated'],
      ['timeout', 1, 'input timed out before EOF'],
    ] as const) {
      expect(await run(`cancel-${mode}`, mode)).toEqual({ code, signal: null,
        receipt: { v: 1, valid: false, problems: [{ field: 'stdin', detail }] } });
      expect(inbox()).toHaveLength(0);
      expect(readdirSync(stage)).toEqual([]);
    }
    expect((await run('preview-114', 'preview')).receipt).toMatchObject({ valid: true, status: 'preview' });
    expect(inbox()).toHaveLength(0);
    expect(await run('complete-114', 'complete')).toMatchObject({ code: 0, signal: null,
      receipt: { status: 'posted', id: 'complete-114' } });
    expect(await run('complete-114', 'complete')).toMatchObject({ code: 0, signal: null,
      receipt: { status: 'duplicate', id: 'complete-114' } });
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]!.envelope).toMatchObject({ id: 'complete-114', from: 'planner-fake', to: 'worker-fake',
      body: { kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) } });
    expect(readdirSync(stage)).toEqual([]);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
