import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { graphContextRun } from '../core/fleet/graph-context-run.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet graph-context-pipe --stdin [--apply] [--concurrency <1..8>] [--input-timeout-ms <1..60000>] [--json]';
const help = `${usage}\n` +
  'Read one UTF-8 JSON context-worker graph (maximum 256 KiB) from a pipe through EOF.\n' +
  'Each task names an absolute snapshot and prompt file plus a literal argv; cited context is untrusted data.\n' +
  'Preview is the default; --apply executes the validated graph through the context worker.\n' +
  '--input-timeout-ms bounds only the stdin read (default 60000 ms); it never bounds total graph execution.\n' +
  'Worker output stays on stderr. Results are sanitized JSON on stdout.\n' +
  'Exit codes: 0 preview/complete, 2 invalid input, 1 failure.';

type Input = Readable & { isTTY?: boolean };
interface PipeIO extends ContextWorkerIO { stdin?: Input; output?: (text: string) => void; tempRoot?: string }
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

export async function cmdFleetGraphContextPipe(args: string[], io: PipeIO = {}): Promise<number> {
  const output = io.output ?? ((text: string) => console.log(text));
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { output(help); return 0; }
  const report = (status: 'invalid' | 'failed', error: string): number => {
    output(JSON.stringify(sanitizePublicJson({ status, nodes: [], error })));
    return status === 'invalid' ? 2 : 1;
  };
  let stdin = false, apply = false, inputTimeout = 60000, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return report('invalid', 'duplicate flag');
    seen.add(arg);
    if (arg === '--stdin') stdin = true;
    else if (arg === '--apply') apply = true;
    else if (arg === '--json') continue;
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--input-timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) inputTimeout = Number(args[++i]);
    else return report('invalid', 'invalid arguments');
  }
  if (!stdin || !Number.isSafeInteger(inputTimeout) || inputTimeout < 1 || inputTimeout > 60000) return report('invalid', 'invalid arguments');
  const input = io.stdin ?? process.stdin;
  if (input.isTTY) return report('invalid', 'stdin must be a pipe');
  const read = await readInput(input, performance.now() + inputTimeout);
  if ('status' in read) return report(read.status, read.error);
  let dir: string | undefined;
  let result: Awaited<ReturnType<typeof graphContextRun>> | undefined;
  let failure = '';
  try {
    dir = mkdtempSync(join(io.tempRoot ?? tmpdir(), 'phantom-graph-context-pipe-'));
    const file = join(dir, 'manifest.json');
    writeFileSync(file, read.bytes, { mode: 0o600, flag: 'wx' });
    result = await graphContextRun(file, apply, io, concurrency);
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
