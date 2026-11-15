import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { cmdFleetHandoffPipe } from '../src/cli/fleet-handoff-pipe.js';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END } from '../src/core/fleet/handoff-bus-receive.js';
import { renderHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

it('preserves a chunked handoff through the public pipe and receiver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-roundtrip-'));
  const stage = join(dir, 'stage'), root = join(dir, 'bus'), snapshot = join(dir, 'snapshot.json');
  mkdirSync(stage);
  const handoff: WorkerHandoff = { id: 'WORK-ROUNDTRIP-1', task: 'Inspect café context',
    files: [{ path: 'src/fixture.ts', why: 'Synthetic fixture' }],
    constraints: [{ rule: 'Keep context intact', reason: 'Teammate needs it' }],
    check: 'Verify the synthetic result', findings: ['One retained finding'] };
  const bytes = Buffer.from(JSON.stringify(handoff));
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  const output: string[] = [];
  let childOutput = '', childError = '';
  const sink = (write: (value: string) => void) => new Writable({
    write(chunk, _encoding, done) { write(String(chunk)); done(); },
  });
  const pipe = (input: Buffer[], apply = false) => cmdFleetHandoffPipe([
    '--stdin', '--id', 'message-roundtrip-1', '--from', 'planner-fake', '--to', 'worker-fake',
    '--json', ...(apply ? ['--apply'] : []),
  ], { stdin: Readable.from(input), root, tempRoot: stage });
  const receive = (id: string, to: string) => cmdFleetHandoffReceive([
    '--id', id, '--to', to, '--snapshot', snapshot, '--', process.execPath, '-e',
    'process.stdin.pipe(process.stdout)',
  ], { root }, { stdout: sink(s => { childOutput += s; }), stderr: sink(s => { childError += s; }) });
  try {
    vi.stubEnv('HOME', dir);
    vi.stubEnv('ASHLR_HOME', join(dir, 'ashlr'));
    vi.stubEnv('ASHLR_RUNS_DIR', join(dir, 'runs'));
    vi.stubEnv('TMPDIR', dir);
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
    vi.spyOn(console, 'error').mockImplementation((value: unknown) => { output.push(String(value)); });
    writeFileSync(snapshot, JSON.stringify({ node: { jobId: handoff.id, upstreamJobIds: [] },
      tasks: [{ jobId: handoff.id, text: 'Synthetic snapshot context' }], outputs: [], byteBudget: 8192 }));
    const chunks = [bytes.subarray(0, split), bytes.subarray(split, split + 1), bytes.subarray(split + 1)];
    expect(split).toBeGreaterThan(1);
    expect(await pipe(chunks)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ valid: true, status: 'preview' });
    expect(await receive('message-roundtrip-1', 'worker-fake')).toBe(1);
    expect(childOutput).toBe('');
    expect(readdirSync(stage)).toEqual([]);
    childError = '';
    expect(await pipe([Buffer.from('{ invalid')], true)).toBe(1);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ valid: false });
    expect(readdirSync(stage)).toEqual([]);
    expect(await pipe(chunks, true)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: 'posted', id: 'message-roundtrip-1' });
    expect(readdirSync(stage)).toEqual([]);
    expect(await pipe(chunks, true)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: 'duplicate', id: 'message-roundtrip-1' });
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('inbox unavailable');
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.envelope).toMatchObject({ id: 'message-roundtrip-1', from: 'planner-fake',
      to: 'worker-fake', body: { kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) } });
    expect(await receive('message-roundtrip-1', 'other-fake')).toBe(1);
    expect(childOutput).toBe('');
    childError = '';
    expect(await receive('message-roundtrip-1', 'worker-fake')).toBe(0);
    expect(childError).toBe('');
    expect(childOutput.startsWith(HANDOFF_RECEIVE_BEGIN + renderHandoff(handoff) + HANDOFF_RECEIVE_END)).toBe(true);
    expect(childOutput).toContain('Synthetic snapshot context');
    expect(readdirSync(stage)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
