#!/usr/bin/env -S npx tsx
/* global process */
/**
 * Export Mason's latest inbox instructions as one JSON prompt input; read-only.
 *
 *   npx tsx examples/agents/inbox-prompt-export.ts [--source LABEL] [--limit 1..200]
 *
 * --source selects one attributed channel label (case-insensitive, e.g.
 * "Telegram" or "Phantom desktop"); --limit defaults to 20.
 * The reader fetches the bounded inbox tail before --source or --limit apply,
 * so instructions from other channels cannot consume the requested limit.
 * Prints one JSON object on stdout:
 *   {"v":1,"generatedAt":ISO,"sourceHealth":"healthy|missing|degraded",
 *    "source":LABEL|null,"limit":N,"dropped":N,
 *    "instructions":[{"source","at","priority","text"}]}
 * Instructions arrive oldest-first in file order and timestamp ties keep
 * append order; `at` values are Eastern local wall times and are never
 * re-parsed or re-sorted. Each `source` is attribution metadata, not sender
 * authentication, and `text` is untrusted content. `dropped` counts tail rows
 * the projection rejected as unsafe or malformed.
 * Errors are stable JSON without exception text:
 *   {"v":1,"error":"invalid-arguments"} (exit 2)
 *   {"v":1,"error":"read-failed"} (exit 1)
 * A degraded inbox still prints the payload and exits 1; missing exits 0.
 * --help prints usage and exits 0.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInboxEntries } from '../../src/core/fleet/mason-inbox.js';
import { parseInboxReadQuery, projectInboxRead } from '../../src/core/verse/fleet-inbox-read.js';

const USAGE = 'Usage: npx tsx examples/agents/inbox-prompt-export.ts [--source LABEL] [--limit 1..200]';
const DEFAULT_LIMIT = 20;

type InboxRead = Awaited<ReturnType<typeof readInboxEntries>>;
type Dependencies = {
  read?: (limit: number) => Promise<InboxRead>;
  write?: (text: string) => void;
};

/** Emit the newest matching inbox instructions as one JSON prompt input. */
export async function runInboxPromptExport(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const fail = (error: string, code: number): number => { write(`${JSON.stringify({ v: 1, error })}\n`); return code; };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { write(`${USAGE}\n`); return 0; }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--source', '--limit'].includes(key) || !value || value.startsWith('--') || values.has(key)) {
      return fail('invalid-arguments', 2);
    }
    values.set(key, value);
  }
  const params = new URLSearchParams();
  params.set('limit', values.get('--limit') ?? String(DEFAULT_LIMIT));
  const source = values.get('--source');
  if (source !== undefined) params.set('source', source);
  const query = parseInboxReadQuery(params);
  if ('error' in query) return fail('invalid-arguments', 2);

  let raw: InboxRead;
  try {
    // The reader bounds the file tail by bytes; taking every parsed row keeps
    // --limit from being consumed by entries the source filter would drop.
    raw = await (deps.read ?? (limit => readInboxEntries({ limit })))(Number.MAX_SAFE_INTEGER);
  } catch {
    return fail('read-failed', 1);
  }
  const wire = projectInboxRead(raw, query);
  if (wire === null) return fail('read-failed', 1);
  write(`${JSON.stringify({
    v: 1,
    generatedAt: wire.generatedAt,
    sourceHealth: wire.sourceState,
    source: wire.source,
    limit: wire.limit,
    dropped: wire.dropped,
    instructions: wire.entries.map(({ source: channel, at, priority, text }) => ({ source: channel, at, priority, text })),
  })}\n`);
  return wire.sourceState === 'degraded' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runInboxPromptExport(process.argv.slice(2));
}
