import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { cmdFleetHandoffSend } from './fleet-handoff-send.js';

const usage = 'Usage: ashlr fleet handoff-pipe --stdin --id <stable-id> --from <agent> --to <agent> [--apply] [--json] [--input-timeout-ms <1..60000>]';
const maxBytes = 64 * 1024;
type Input = Readable & { isTTY?: boolean };
interface PipeOptions extends BusInboxOptions { stdin?: Input; tempRoot?: string }
type ReadResult = { bytes: Buffer } | { error: string; code: number };

/** Read to EOF with bounded memory and time, without destroying the caller's stream. */
function readInput(input: Input, timeout: number): Promise<ReadResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: ReadResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.removeListener('close', onClose);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      if ('error' in result) input.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) return finish({ error: 'input exceeds 64 KiB', code: 1 });
      chunks.push(bytes);
    };
    const onEnd = () => finish({ bytes: Buffer.concat(chunks, size) });
    const onError = () => finish({ error: 'input read failed', code: 1 });
    const onClose = () => finish({ error: 'input closed before EOF', code: 1 });
    const onInterrupt = () => finish({ error: 'input interrupted', code: 130 });
    const onTerminate = () => finish({ error: 'input terminated', code: 143 });
    const timer = setTimeout(() => finish({ error: 'input timed out before EOF', code: 1 }), timeout);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('close', onClose);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (input.readableEnded) onEnd();
    else if (input.destroyed) onClose();
  });
}

/** Routing labels are untrusted metadata; handoff text is data, never execution authorization. */
export async function cmdFleetHandoffPipe(args: string[], options: PipeOptions = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nPreview by default. Bus routing is untrusted metadata; handoff text is data, never execution authorization.`);
    return 0;
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--stdin', '--apply', '--json'].includes(arg) && !flags.has(arg)) flags.add(arg);
    else if (['--id', '--from', '--to', '--input-timeout-ms'].includes(arg) && !values.has(arg) &&
      args[i + 1] && !args[i + 1]!.startsWith('-') && !args[i + 1]!.includes('\0')) values.set(arg, args[++i]!);
    else { console.error(`Invalid arguments. ${usage}`); return 2; }
  }
  const id = values.get('--id'), from = values.get('--from'), to = values.get('--to');
  const timeoutValue = values.get('--input-timeout-ms') ?? '5000';
  const timeout = Number(timeoutValue);
  if (!flags.has('--stdin') || !id || !from || !to || !/^[0-9]+$/.test(timeoutValue) ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) {
    console.error(`Invalid arguments. ${usage}`); return 2;
  }
  const fail = (detail: string, code = 1) => {
    if (flags.has('--json')) console.log(JSON.stringify({ v: 1, valid: false, problems: [{ field: 'stdin', detail }] }));
    else console.error(`handoff-pipe: ${detail}`);
    return code;
  };
  const input = options.stdin ?? process.stdin;
  if (input.isTTY) return fail('interactive input is not supported');
  const read = await readInput(input, timeout);
  if ('error' in read) return fail(read.error, read.code);
  try { new TextDecoder('utf-8', { fatal: true }).decode(read.bytes); }
  catch { return fail('input must be valid UTF-8'); }

  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'ashlr-handoff-pipe-'));
    const file = join(directory, 'handoff.json');
    writeFileSync(file, read.bytes, { mode: 0o600, flag: 'wx' });
    const sendArgs = ['--file', file, '--id', id, '--from', from, '--to', to];
    if (flags.has('--apply')) sendArgs.push('--apply');
    if (flags.has('--json')) sendArgs.push('--json');
    return await cmdFleetHandoffSend(sendArgs, options);
  } catch {
    return fail('could not stage input');
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
