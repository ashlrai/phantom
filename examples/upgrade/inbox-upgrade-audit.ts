#!/usr/bin/env -S npx tsx
/* global process */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInboxEntries, type InboxEntry } from '../../src/core/fleet/mason-inbox.js';
import { parseInboxReadQuery, projectInboxRead, type FleetInboxReadV1 } from '../../src/core/verse/fleet-inbox-read.js';

const HELP = `Usage: npx tsx examples/upgrade/inbox-upgrade-audit.ts --limit N (--all-sources | --source LABEL)

Compare the canonical inbox window with the HTTP projection without printing entries.
Exit codes: 0 verified, 1 mismatch or failure, 2 usage, 3 insufficient evidence.
`;
type Query = Exclude<ReturnType<typeof parseInboxReadQuery>, { error: string }>;
type Inbox = Awaited<ReturnType<typeof readInboxEntries>>;
type Dependencies = {
  read?: (limit: number) => Promise<Inbox>;
  project?: (raw: Inbox, query: Query) => FleetInboxReadV1 | null;
  write?: (text: string) => void;
};

// Fixed buckets prevent arbitrary inbox headings from entering the report.
function distribution(entries: InboxEntry[]) {
  const counts = { telegram: 0, desktop: 0, relayed: 0, terminal: 0, unknown: 0, other: 0 };
  for (const { source } of entries) {
    switch (source.toLowerCase()) {
      case 'telegram': counts.telegram++; break;
      case 'phantom desktop': counts.desktop++; break;
      case 'relayed by masbot': counts.relayed++; break;
      case 'terminal': counts.terminal++; break;
      case 'unknown': counts.unknown++; break;
      default: counts.other++;
    }
  }
  return counts;
}

/** Compare one bounded window with the same projection used by the HTTP route. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  if (args.length === 1 && args[0] === '--help') {
    write(HELP);
    return 0;
  }
  const usage = () => { write('{"v":1,"error":"Invalid arguments. Use --help for usage."}\n'); return 2; };
  const params = new URLSearchParams();
  let allSources = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all-sources' && !allSources) allSources = true;
    else if ((arg === '--limit' || arg === '--source') && i + 1 < args.length) {
      params.append(arg.slice(2), args[++i]!);
    } else return usage();
  }
  if (params.getAll('limit').length !== 1 || (allSources ? params.has('source') : params.getAll('source').length !== 1)) return usage();
  const query = parseInboxReadQuery(params);
  if ('error' in query) return usage();

  try {
    const raw = await (deps.read ?? (limit => readInboxEntries({ limit })))(query.limit);
    // The real reader is bounded by the requested limit; reject a broken adapter.
    if (!Array.isArray(raw.entries) || raw.entries.length > query.limit) throw new Error();
    const wire = (deps.project ?? projectInboxRead)(raw, query);
    if (!wire || wire.entries.length > query.limit) throw new Error();
    const selected = raw.entries.filter(entry => query.source === null || entry.source.toLowerCase() === query.source.toLowerCase()).reverse();
    const compatible = selected.length === wire.entries.length && selected.every((entry, index) => {
      const actual = wire.entries[index];
      return actual && entry.at === actual.at && entry.source === actual.source
        && entry.priority === actual.priority && entry.text === actual.text;
    });
    const healthCompatible = raw.sourceState === wire.sourceState;
    const selectionCompatible = wire.v === 1 && wire.limit === query.limit && wire.source === query.source;
    const mismatch = !compatible || !healthCompatible || !selectionCompatible || wire.dropped !== 0;
    const insufficient = raw.sourceState !== 'healthy' || selected.length === 0;
    const exit = mismatch ? 1 : insufficient ? 3 : 0;
    write(`${JSON.stringify({
      v: 1, limit: query.limit, sourceFiltered: query.source !== null,
      health: { canonical: raw.sourceState, projection: wire.sourceState },
      counts: { canonicalWindow: raw.entries.length, canonicalSelected: selected.length, projected: wire.entries.length, dropped: wire.dropped },
      sources: { canonical: distribution(selected), projection: distribution(wire.entries) },
      compatibility: { selection: selectionCompatible, health: healthCompatible, orderAttributionAndContent: compatible },
      result: exit === 0 ? 'verified' : exit === 1 ? 'mismatch' : 'insufficient-evidence',
    })}\n`);
    return exit;
  } catch {
    write('{"v":1,"error":"Unable to audit inbox."}\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
