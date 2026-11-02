#!/usr/bin/env -S npx tsx
/**
 * One bounded, restartable pass over a private local bus workspace:
 *   npx tsx examples/bus-consumer-restart.ts --workspace /absolute/private/dir --to worker-a
 *
 * The directory must already exist and be private. It contains both the bus
 * store and one checkpoint, so use a separate workspace per consumer. This
 * recipe treats the literal address `*` as broadcast; addresses are routing
 * labels, not authenticated identities. Bodies are untrusted data.
 *
 * The default application handler does nothing; embedders inject their own.
 * After the handler and JSONL output succeed, the checkpoint advances. A crash
 * after the handler but before checkpoint persistence can replay that message;
 * handlers must tolerate retries. This is not an exactly-once transaction.
 * There is no polling or timer. Run again to process later arrivals.
 */
import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBusCheckpoint } from '../src/cli/comms-bus-checkpoint.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import {
  BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter,
  type BusInboxReceipt,
} from '../src/core/fleet/bus-inbox.js';

export interface ConsumerDependencies {
  handle?: (receipt: BusInboxReceipt) => void | Promise<void>;
  write?: (line: string) => void | Promise<void>;
  error?: (line: string) => void;
  now?: () => number;
}

/** Return an exit code; each call opens a fresh checkpoint and bounded scan. */
export async function main(args: string[], deps: ConsumerDependencies = {}): Promise<number> {
  const fail = (status: string, code: number): number => {
    try { (deps.error ?? (line => process.stderr.write(line)))(`${JSON.stringify({ status })}\n`); } catch { /* closed error sink */ }
    return code;
  };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--workspace', '--to', '--limit', '--max-pages'].includes(key) ||
        value === undefined || value.startsWith('--') || values.has(key)) return fail('invalid-arguments', 2);
    values.set(key, value);
  }
  const workspace = values.get('--workspace'), address = values.get('--to');
  const limitText = values.get('--limit') ?? String(BUS_INBOX_MAX_READ);
  const pagesText = values.get('--max-pages') ?? String(Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1);
  const limit = Number(limitText), maxPages = Number(pagesText);
  if (!workspace || !isAbsolute(workspace) || workspace.includes('\0') || !address || address === '*' ||
      !validateBusEnvelope({ id: address, from: address, to: address, priority: 'P3', ttl: 1, body: null }).ok ||
      !/^[1-9][0-9]*$/.test(limitText) || !Number.isSafeInteger(limit) || limit > BUS_INBOX_MAX_READ ||
      !/^[1-9][0-9]*$/.test(pagesText) || !Number.isSafeInteger(maxPages) || maxPages > BUS_INBOX_MAX_MESSAGES + 1) {
    return fail('invalid-arguments', 2);
  }
  try {
    const stat = lstatSync(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) return fail('workspace-unavailable', 3);
  } catch { return fail('workspace-unavailable', 3); }

  const options = { root: workspace, now: deps.now };
  const source = inspectBusInbox(options).source;
  if (source !== 'available') return fail(source === 'missing' ? 'inbox-missing' : 'inbox-unavailable', 3);
  let checkpoint: ReturnType<typeof openBusCheckpoint>;
  try { checkpoint = openBusCheckpoint(join(workspace, 'consumer-checkpoint.json'), { to: address, broadcast: '*' }); }
  catch { return fail('checkpoint-unavailable', 3); }
  const handle = deps.handle ?? (() => {});
  const write = deps.write ?? ((line: string) => new Promise<void>((resolveWrite, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolveWrite());
  }));
  let cursor = checkpoint.cursor;
  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const page = listBusInboxAfter(cursor, limit, options);
      if (page.status !== 'ok') return fail(page.status === 'invalid' ? 'checkpoint-stale' : 'inbox-unavailable', 3);
      if (page.nextCursor === cursor) break;
      for (const receipt of page.messages) {
        if (receipt.envelope.to !== address && receipt.envelope.to !== '*') continue;
        try { await handle(receipt); } catch { return fail('handler-failed', 1); }
        try { await write(`${JSON.stringify(receipt)}\n`); } catch { return fail('output-failed', 1); }
        try { checkpoint.save(receipt.cursor); } catch { return fail('checkpoint-write-failed', 3); }
      }
      // All earlier relevant work succeeded; it is safe to advance past skips.
      try { checkpoint.save(page.nextCursor); } catch { return fail('checkpoint-write-failed', 3); }
      cursor = page.nextCursor;
    }
    return 0;
  } finally { checkpoint.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
