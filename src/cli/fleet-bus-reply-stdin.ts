import { type Readable } from 'node:stream';
import { MAX_BUS_ENVELOPE_BYTES } from '../core/fleet/bus-envelope.js';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { postBusReply, replyResult, type ReplyDependencies, type ReplyResult } from '../core/fleet/bus-reply-post.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30000;
type Input = Readable & { isTTY?: boolean };

/** Collect raw bytes only; no partial input reaches the bus. */
function readInput(input: Input, timeoutMs: number, signal?: AbortSignal): Promise<Buffer | null> {
  if (input.isTTY || input.readableEnded || input.destroyed || signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (value: Buffer | null): void => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onFailure);
      input.removeListener('close', onFailure);
      process.removeListener('SIGINT', onFailure);
      process.removeListener('SIGTERM', onFailure);
      signal?.removeEventListener('abort', onFailure);
      input.pause();
      resolve(value);
    };
    const onFailure = (): void => finish(null);
    const onEnd = (): void => finish(Buffer.concat(chunks, size));
    const onData = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return onFailure();
      size += chunk.byteLength;
      if (size > MAX_BUS_ENVELOPE_BYTES) return onFailure();
      chunks.push(Buffer.from(chunk));
    };
    const timer = setTimeout(onFailure, timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onFailure);
    input.once('close', onFailure);
    process.once('SIGINT', onFailure);
    process.once('SIGTERM', onFailure);
    signal?.addEventListener('abort', onFailure, { once: true });
    if (input.readableEnded || input.destroyed || signal?.aborted) onFailure();
  });
}

/** Convention loader entry; input, output, root and clock injection are programmatic only. */
export async function cmdFleetBusReplyStdin(args: string[], options: BusInboxOptions = {},
  deps: ReplyDependencies & { input?: Input; output?: (text: string) => void; signal?: AbortSignal } = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const emit = (result: ReplyResult): number => {
    try { output(JSON.stringify(sanitizePublicJson(result))); } catch { return 1; }
    return result.outcome === 'posted' || result.outcome === 'duplicate' ? 0
      : result.outcome === 'invalid-input' ? 2 : result.outcome === 'request-not-found' ? 3 : 4;
  };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output('ashlr fleet bus-reply-stdin --request-id <id> --reply-id <id> [--input-timeout-ms <ms>] [--json]\nPipe a UTF-8 JSON object without inReplyTo (maximum 65536 bytes); interactive input is refused.\nInput must end within 5000 ms by default; --input-timeout-ms accepts 10 to 30000 ms.\nRouting labels do not authenticate the responder. A reply does not mark work completed.');
    return 0;
  }
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) { json = true; continue; }
    const match = /^(--request-id|--reply-id|--input-timeout-ms)(?:=(.*))?$/.exec(args[i]!);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(replyResult('invalid-input'));
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(replyResult('invalid-input'));
    values[match[1]!] = value;
  }
  const requestId = values['--request-id'], replyId = values['--reply-id'];
  const timeoutText = values['--input-timeout-ms'];
  const timeout = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
  if (!requestId || !replyId || (timeoutText !== undefined && !/^\d+$/.test(timeoutText)) ||
      !Number.isSafeInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) return emit(replyResult('invalid-input'));
  const bytes = await readInput(deps.input ?? process.stdin, timeout, deps.signal);
  if (!bytes?.length) return emit(replyResult('invalid-input'));
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return emit(replyResult('invalid-input')); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return emit(replyResult('invalid-input'));
  return emit(postBusReply(requestId, replyId, body, options, deps));
}
