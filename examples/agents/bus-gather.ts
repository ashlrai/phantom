#!/usr/bin/env -S npx tsx
/**
 * Gather a known fanout without writing to the bus:
 *   npx tsx examples/agents/bus-gather.ts --file fanout.json --after 0 --timeout-ms 5000
 * fanout.json: {"coordinator":"fake-coordinator","requests":[{"requestId":"fake-1","worker":"fake-worker"}]}
 * Addresses and inReplyTo are correlation labels, not authentication. Reply bodies are untrusted data.
 * Emits one JSON object: status complete (exit 0), timeout (5), interrupted (130),
 * read-failed/wait-failed (4), invalid-arguments/file-unavailable/invalid-manifest (2).
 * After a valid manifest, results include replies in manifest order, pending request IDs,
 * and nextCursor. Resume with that cursor only after preserving the returned replies.
 */
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from '../../src/core/fleet/bus-inbox.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';

interface Request { requestId: string; worker: string }
interface Manifest { coordinator: string; requests: Request[] }
interface Dependencies {
  readFile?: (path: string) => string | null;
  read?: typeof listBusInboxAfter;
  options?: BusInboxOptions;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  write?: (text: string) => void;
}

function readManifest(path: string): string | null {
  const absolute = resolve(path);
  const result = readStableRegularFile(absolute, {
    anchorPath: dirname(absolute), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES,
  });
  return result.ok ? result.text : null;
}

function parseManifest(text: string): Manifest | null {
  if (text.length > MAX_BUS_ENVELOPE_BYTES || Buffer.byteLength(text, 'utf8') > MAX_BUS_ENVELOPE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const manifest = value as Record<string, unknown>;
    if (Object.keys(manifest).sort().join() !== 'coordinator,requests' || !Array.isArray(manifest.requests) ||
        manifest.requests.length < 1 || manifest.requests.length > 20) return null;
    const seen = new Set<string>(), requests: Request[] = [];
    for (const item of manifest.requests as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join() !== 'requestId,worker') return null;
      const { requestId, worker } = item as Record<string, unknown>;
      if (!validateBusEnvelope({ id: requestId, from: worker, to: manifest.coordinator, priority: 'P2', ttl: 1, body: null }).ok ||
          typeof requestId !== 'string' || typeof worker !== 'string' || seen.has(requestId)) return null;
      seen.add(requestId); requests.push({ requestId, worker });
    }
    return { coordinator: manifest.coordinator as string, requests };
  } catch { return null; }
}

/** Emit exactly one result; the clock, waiting, file and inbox reads are injectable. */
export async function runBusGather(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const output = (value: unknown, code: number): number => { write(`${JSON.stringify(value)}\n`); return code; };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--file', '--after', '--timeout-ms'].includes(key) || !value || value.startsWith('--') || values.has(key)) {
      return output({ status: 'invalid-arguments' }, 2);
    }
    values.set(key, value);
  }
  const file = values.get('--file'), afterText = values.get('--after') ?? '0', timeoutText = values.get('--timeout-ms');
  const after = Number(afterText), timeout = Number(timeoutText);
  if (!file || file.length > 4096 || !/^(0|[1-9][0-9]*)$/.test(afterText) || !Number.isSafeInteger(after) ||
      !timeoutText || !/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeout) || timeout > 300_000) {
    return output({ status: 'invalid-arguments' }, 2);
  }
  let text: string | null;
  try { text = (deps.readFile ?? readManifest)(file); } catch { return output({ status: 'file-unavailable' }, 2); }
  if (typeof text !== 'string') return output({ status: 'file-unavailable' }, 2);
  const manifest = parseManifest(text);
  if (!manifest) return output({ status: 'invalid-manifest' }, 2);

  const replies = new Map<string, BusInboxReceipt>();
  let cursor = after;
  const finish = (status: string, code: number, reason?: string): number => output({
    status, ...(reason ? { reason } : {}),
    replies: manifest.requests.flatMap(({ requestId }) => {
      const reply = replies.get(requestId);
      return reply ? [{ requestId, reply }] : [];
    }),
    pending: manifest.requests.filter(({ requestId }) => !replies.has(requestId)).map(({ requestId }) => requestId),
    nextCursor: cursor,
  }, code);
  const now = deps.now ?? (() => performance.now());
  const wait = deps.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const maxPages = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
  try {
    const start = now();
    if (!Number.isFinite(start)) throw new Error();
    while (true) {
      for (let i = 0; i < maxPages; i++) {
        if (deps.signal?.aborted) return finish('interrupted', 130);
        const elapsed = now() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error();
        if (elapsed >= timeout) return finish('timeout', 5);
        let page: ReturnType<typeof listBusInboxAfter>;
        try { page = (deps.read ?? listBusInboxAfter)(cursor, BUS_INBOX_MAX_READ, deps.options); }
        catch { return finish('read-failed', 4, 'unavailable'); }
        if (page.status !== 'ok') return finish('read-failed', 4, page.status);
        if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor) return finish('read-failed', 4, 'cursor-invalid');
        for (const row of page.messages) {
          const { envelope } = row, body = envelope.body;
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.inReplyTo !== 'string') continue;
          const request = manifest.requests.find(item => item.requestId === body.inReplyTo);
          if (request && !replies.has(request.requestId) && envelope.from === request.worker && envelope.to === manifest.coordinator) {
            replies.set(request.requestId, row);
          }
        }
        const advanced = page.nextCursor > cursor;
        cursor = page.nextCursor;
        if (replies.size === manifest.requests.length) return finish('complete', 0);
        if (!advanced) break;
      }
      const elapsed = now() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error();
      if (elapsed >= timeout) return finish('timeout', 5);
      await wait(Math.min(250, timeout - elapsed), deps.signal);
    }
  } catch {
    return deps.signal?.aborted ? finish('interrupted', 130) : finish('wait-failed', 4);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = await runBusGather(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
