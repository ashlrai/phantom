import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { graphArgvRun } from '../core/fleet/graph-argv-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet graph-pipe --stdin [--apply] [--concurrency <1..8>] [--timeout-ms <1..3600000>] [--json]';
const help = `${usage}\n` +
  'Read one UTF-8 JSON argv graph (maximum 256 KiB) from a pipe through EOF.\n' +
  'Preview is the default; --apply executes the validated graph using fleet switches.\n' +
  '--timeout-ms bounds stdin and execution together (default 900000 ms).\n' +
  'Results are sanitized JSON. Exit codes: 0 preview/complete, 2 invalid input, 1 failure.';

type Input = Readable & { isTTY?: boolean };
interface PipeIO { stdin?: Input; output?: (text: string) => void; tempRoot?: string }
type ReadResult = { bytes: Buffer } | { status: 'invalid' | 'failed'; error: string };

function readInput(input: Input, deadline: number): Promise<ReadResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: ReadResult): void => {
      clearTimeout(timer);
      input.removeListener('data', data); input.removeListener('end', end);
      input.removeListener('error', error); input.removeListener('close', close);
      process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
      input.pause();
      resolve(result);
    };
    const data = (chunk: unknown): void => {
      if (performance.now() >= deadline) return finish({ status: 'failed', error: 'stdin deadline exhausted' });
      if (!Buffer.isBuffer(chunk)) return finish({ status: 'invalid', error: 'stdin must contain UTF-8 bytes' });
      size += chunk.length;
      if (size > 262144) return finish({ status: 'invalid', error: 'stdin exceeds 256 KiB' });
      chunks.push(chunk);
    };
    const end = (): void => {
      if (performance.now() >= deadline) return finish({ status: 'failed', error: 'stdin deadline exhausted' });
      const bytes = Buffer.concat(chunks);
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return finish({ status: 'invalid', error: 'stdin is not valid UTF-8' }); }
      finish({ bytes });
    };
    const error = (): void => finish({ status: 'failed', error: 'could not read stdin' });
    const close = (): void => finish({ status: 'failed', error: 'stdin closed before EOF' });
    const signal = (): void => finish({ status: 'failed', error: 'stdin interrupted' });
    const timer = setTimeout(() => finish({ status: 'failed', error: 'stdin deadline exhausted' }), Math.max(0, deadline - performance.now()));
    process.on('SIGINT', signal); process.on('SIGTERM', signal);
    input.on('error', error); input.on('close', close); input.on('end', end); input.on('data', data);
    if (input.readableEnded) end();
    else if (input.destroyed) close();
  });
}

export async function cmdFleetGraphPipe(args: string[], io: PipeIO = {}): Promise<number> {
  const output = io.output ?? ((text: string) => console.log(text));
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { output(help); return 0; }
  const report = (status: 'invalid' | 'failed', error: string): number => {
    output(JSON.stringify(sanitizePublicJson({ status, nodes: [], error })));
    return status === 'invalid' ? 2 : 1;
  };
  let stdin = false, apply = false, timeout = 900000, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return report('invalid', 'duplicate flag');
    seen.add(arg);
    if (arg === '--stdin') stdin = true;
    else if (arg === '--apply') apply = true;
    else if (arg === '--json') continue;
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return report('invalid', 'invalid arguments');
  }
  if (!stdin || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000) return report('invalid', 'invalid arguments');
  const input = io.stdin ?? process.stdin;
  if (input.isTTY) return report('invalid', 'stdin must be a pipe');
  const deadline = performance.now() + timeout;
  const read = await readInput(input, deadline);
  if ('status' in read) return report(read.status, read.error);
  let dir: string | undefined;
  let result: Awaited<ReturnType<typeof graphArgvRun>> | undefined;
  let failure = '';
  try {
    dir = mkdtempSync(join(io.tempRoot ?? tmpdir(), 'phantom-graph-pipe-'));
    const file = join(dir, 'manifest.json');
    writeFileSync(file, read.bytes, { mode: 0o600, flag: 'wx' });
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) failure = 'deadline exhausted';
    else result = await graphArgvRun(file, apply, remaining, concurrency);
  } catch {
    failure = 'could not stage or run graph';
  } finally {
    try { if (dir) rmSync(dir, { recursive: true, force: true }); }
    catch { failure = 'could not clean staging directory'; }
  }
  if (failure || !result) return report('failed', failure || 'could not run graph');
  output(JSON.stringify(sanitizePublicJson(result)));
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
