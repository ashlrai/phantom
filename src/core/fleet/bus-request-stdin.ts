import { performance } from 'node:perf_hooks';
import { type Readable } from 'node:stream';
import { MAX_BUS_ENVELOPE_BYTES } from './bus-envelope.js';

type InputResult = { status: 'ok'; text: string } | { status: 'invalid-input' | 'timeout' | 'cancelled' };

/** Read raw, bounded input without taking ownership of the stream. Deadline uses performance.now(). */
export function readBusRequestStdin(input: Readable, deadline: number, signal: AbortSignal): Promise<InputResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0, finished = false;
    const wasFlowing = input.readableFlowing === true;
    const stop = (): InputResult | null => signal.aborted ? { status: 'cancelled' }
      : performance.now() >= deadline ? { status: 'timeout' } : null;
    const finish = (result: InputResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off('data', onData); input.off('end', onEnd);
      input.off('error', onFailure); input.off('close', onFailure);
      signal.removeEventListener('abort', onAbort);
      if (!wasFlowing) input.pause();
      resolve(result);
    };
    const onAbort = (): void => finish({ status: 'cancelled' });
    const onFailure = (): void => finish(stop() ?? { status: 'invalid-input' });
    const onEnd = (): void => {
      const stopped = stop();
      if (stopped) return finish(stopped);
      if (!size) return finish({ status: 'invalid-input' });
      try { finish({ status: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)) }); }
      catch { finish({ status: 'invalid-input' }); }
    };
    const onData = (chunk: unknown): void => {
      const stopped = stop();
      if (stopped) return finish(stopped);
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return onFailure();
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (bytes > MAX_BUS_ENVELOPE_BYTES - size) return onFailure();
      const copy = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      // Strings from injected streams must round-trip without replacement of invalid surrogates.
      if (typeof chunk === 'string' && copy.toString('utf8') !== chunk) return onFailure();
      size += bytes;
      chunks.push(copy);
    };
    const timer = setTimeout(() => finish(stop() ?? { status: 'timeout' }), Math.max(0, deadline - performance.now()));
    const initial = stop();
    if (initial) return finish(initial);
    // A stream decoder can already have silently replaced malformed UTF-8.
    if (input.readableEncoding || input.destroyed || input.readableEnded) return finish({ status: 'invalid-input' });
    input.on('data', onData); input.once('end', onEnd);
    input.once('error', onFailure); input.once('close', onFailure);
    signal.addEventListener('abort', onAbort, { once: true });
    const afterSetup = stop();
    if (afterSetup) finish(afterSetup);
  });
}
