#!/usr/bin/env -S npx tsx
/** Compose one data-only response from saved JSON files and append it to the local bus. */
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope, validateBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../../src/core/fleet/bus-inbox.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';

interface Dependencies {
  readFile?: (path: string) => string | null;
  append?: typeof appendBusInbox;
  options?: BusInboxOptions;
  write?: (line: string) => void;
}

function readFile(path: string): string | null {
  const absolute = resolve(path);
  const result = readStableRegularFile(absolute, {
    anchorPath: dirname(absolute), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES,
  });
  return result.ok ? result.text : null;
}

/** Return an exit code and emit one JSON result. No waiting or retries are performed. */
export function runBusReplyFile(args: string[], deps: Dependencies = {}): number {
  const write = deps.write ?? ((line: string) => console.log(line));
  const output = (value: unknown, code: number): number => { write(JSON.stringify(value)); return code; };
  const values = new Map<string, string>();
  const allowed = ['--request-file', '--body-file', '--from', '--id', '--ttl', '--priority', '--root'];
  if (args.length > allowed.length * 2) return output({ status: 'invalid-arguments' }, 2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.includes(key) || value === undefined || value.length === 0 || value.length > 4096 ||
        value.startsWith('--') || values.has(key)) return output({ status: 'invalid-arguments' }, 2);
    values.set(key, value);
  }
  if (['--request-file', '--body-file', '--from', '--id', '--ttl'].some(key => !values.has(key)) ||
      (values.has('--root') && !isAbsolute(values.get('--root')!))) return output({ status: 'invalid-arguments' }, 2);
  const ttlText = values.get('--ttl')!;
  const ttl = Number(ttlText);
  if (!/^[1-9][0-9]*$/.test(ttlText) || !Number.isSafeInteger(ttl)) return output({ status: 'invalid-arguments' }, 2);

  const reader = deps.readFile ?? readFile;
  let requestText: string | null, bodyText: string | null;
  try {
    requestText = reader(values.get('--request-file')!);
    bodyText = reader(values.get('--body-file')!);
  } catch { return output({ status: 'file-unavailable' }, 2); }
  if (typeof requestText !== 'string' || typeof bodyText !== 'string') return output({ status: 'file-unavailable' }, 2);
  const request = parseBusEnvelope(requestText);
  if (!request.ok) return output({ status: 'invalid-request', issues: request.issues }, 2);
  if (bodyText.length > MAX_BUS_ENVELOPE_BYTES || Buffer.byteLength(bodyText, 'utf8') > MAX_BUS_ENVELOPE_BYTES) {
    return output({ status: 'invalid-body' }, 2);
  }
  let payload: unknown;
  try { payload = JSON.parse(bodyText); } catch { return output({ status: 'invalid-body' }, 2); }
  const response = validateBusEnvelope({
    id: values.get('--id'), from: values.get('--from'), to: request.value.from,
    priority: values.get('--priority') ?? request.value.priority, ttl,
    body: { replyTo: request.value.id, payload },
  });
  if (!response.ok) return output({ status: 'invalid-response', issues: response.issues }, 2);
  const options = { ...deps.options, ...(values.has('--root') ? { root: values.get('--root') } : {}) };
  try {
    const receipt = (deps.append ?? appendBusInbox)(response.value, options);
    return output(receipt, receipt.status === 'posted' || receipt.status === 'duplicate' ? 0 : 3);
  } catch { return output({ status: 'unavailable' }, 3); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runBusReplyFile(process.argv.slice(2));
}
