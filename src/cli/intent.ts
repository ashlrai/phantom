/**
 * `phm intent` reads and writes the local ashlr.intent-ledger/v1 file.
 * The ledger stays in the owner's state directory.
 */
import {
  addIntent,
  getIntent,
  importIntentFiles,
  listIntents,
  noteMergedPulls,
  noteShippedRelease,
  sweepStale,
  updateIntent,
} from '../core/intent/ledger.js';
import { IntentError, isIntentStatus, type IntentStatus } from '../core/intent/schema.js';

const USAGE = `phm intent list [--status <status>] [--json]
phm intent get <id> [--json]
phm intent add --title <text> --source <label> [--owner <label>] [--rq <key>] [--status <status>] [--stale-after <ms>] [--verbatim] [--json]
phm intent update <id> [--status <status>] [--title <text>] [--owner <label>] [--rq <key>] [--evidence <ref>] [--json]
phm intent import <file.jsonl> [more.jsonl ...] [--json]
phm intent stale [--apply] [--json]
phm intent link --repo <owner/name> --number <n> --title <text> [--branch <name>] [--json]
phm intent ship --release <id> [--notes <text>] [--rq <key>] [--json]

The ledger is ~/.ashlr-runs/intent/ledger.json (ASHLR_RUNS_DIR overrides it). It is not stored in the repo.
Import accepts several JSONL files ({id,title,source,date,rq_key,status}) or one ashlr.intent-ledger/v1 document.
Duplicate RQ keys or normalized titles merge, and each copy keeps its provenance. See docs/INTENT.md.`;

function emit(json: boolean, value: unknown): void {
  console.log(JSON.stringify(value, null, json ? 2 : undefined));
}

function take(args: string[], name: string, flags: Record<string, string>, many?: Record<string, string[]>): void {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new IntentError(`${name} needs a value. Run phm intent --help.`);
  if (many && (name === '--rq' || name === '--file')) {
    (many[name] ??= []).push(value);
    return;
  }
  if (flags[name] !== undefined) throw new IntentError(`${name} was given twice.`);
  flags[name] = value;
}

export async function cmdIntent(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const apply = args.includes('--apply');
  const verbatim = args.includes('--verbatim');
  try {
    const rest = args.filter((arg) => arg !== '--json' && arg !== '--apply' && arg !== '--verbatim');
    const verb = rest.shift();
    if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
      if (json) emit(true, { usage: USAGE }); else console.log(USAGE);
      return 0;
    }
    const flags: Record<string, string> = {};
    const many: Record<string, string[]> = {};
    const position: string[] = [];
    while (rest.length) {
      const token = rest.shift()!;
      if (token === '--title' || token === '--source' || token === '--owner' || token === '--status' || token === '--stale-after' || token === '--repo' || token === '--number' || token === '--branch' || token === '--url' || token === '--release' || token === '--notes' || token === '--evidence' || token === '--date') {
        take(rest, token, flags);
      } else if (token === '--rq') take(rest, token, flags, many);
      else if (token.startsWith('--')) throw new IntentError('Unknown option. Run phm intent --help.');
      else position.push(token);
    }
    const status = flags['--status'];
    if (status !== undefined && !isIntentStatus(status)) throw new IntentError('Unknown status. Use proposed, queued, in-progress, merged, shipped, verified, superseded, closed, or unknown.');
    const rq = many['--rq'] ?? [];
    if (verb === 'list') {
      if (position.length) throw new IntentError('Unexpected arguments. Run phm intent --help.');
      const listed = await listIntents({ status: status as IntentStatus | undefined });
      if (json) emit(true, { ok: true, ...listed.summary, records: listed.items });
      else for (const item of listed.items) console.log(`${item.id}  [${item.status}]  ${item.title}`);
      return 0;
    }
    if (verb === 'get') {
      if (position.length !== 1) throw new IntentError('Use phm intent get <id>.');
      const item = await getIntent(position[0]!);
      if (!item) throw new IntentError('Intent not found. Run phm intent list.');
      if (json) emit(true, { ok: true, item }); else console.log(`${item.id}  [${item.status}]  ${item.title}`);
      return 0;
    }
    if (verb === 'add') {
      if (!flags['--title'] || !flags['--source']) throw new IntentError('Use phm intent add --title <text> --source <label>.');
      const item = await addIntent({
        title: flags['--title'], source: flags['--source'], owner: flags['--owner'], rq,
        status: status as IntentStatus | undefined,
        staleAfterMs: flags['--stale-after'] ? Number(flags['--stale-after']) : undefined,
        verbatim, date: flags['--date'],
      });
      if (json) emit(true, { ok: true, item }); else console.log(`Added ${item.id}`);
      return 0;
    }
    if (verb === 'update') {
      if (position.length !== 1) throw new IntentError('Use phm intent update <id>.');
      const item = await updateIntent(position[0]!, {
        title: flags['--title'], source: flags['--source'], owner: flags['--owner'],
        status: status as IntentStatus | undefined, rq: rq.length ? rq : undefined,
        evidence: flags['--evidence'] ? { ref: flags['--evidence'], note: flags['--notes'] } : undefined,
      });
      if (json) emit(true, { ok: true, item }); else console.log(`Updated ${item.id}`);
      return 0;
    }
    if (verb === 'import') {
      const result = await importIntentFiles(position);
      if (json) emit(true, { ok: true, schema: 'ashlr.intent-ledger/v1', ...result });
      else console.log(`Imported ${result.imported}, merged ${result.deduped}, ${result.items} items.`);
      return 0;
    }
    if (verb === 'stale') {
      if (position.length) throw new IntentError('Unexpected arguments. Run phm intent --help.');
      const result = await sweepStale({ apply });
      if (json) emit(true, { ok: true, ...result });
      else for (const row of result.stale) console.log(`${row.id}  ${row.action}  ${row.status}  ${row.title}`);
      return 0;
    }
    if (verb === 'link') {
      if (!flags['--repo'] || !flags['--number'] || !flags['--title']) throw new IntentError('Use phm intent link --repo <owner/name> --number <n> --title <text>.');
      const number = Number(flags['--number']);
      const result = await noteMergedPulls([{
        repo: flags['--repo'], number, title: flags['--title'], branch: flags['--branch'], url: flags['--url'],
      }]);
      if (json) emit(true, { ok: true, ...result }); else console.log(`Linked ${result.updated}.`);
      return 0;
    }
    if (verb === 'ship') {
      if (!flags['--release']) throw new IntentError('Use phm intent ship --release <id>.');
      const result = await noteShippedRelease({ release: flags['--release'], notes: flags['--notes'], rq });
      if (json) emit(true, { ok: true, ...result }); else console.log(`Shipped ${result.updated}.`);
      return 0;
    }
    throw new IntentError('Unknown intent command. Run phm intent --help.');
  } catch (error) {
    const message = error instanceof IntentError ? error.message : 'Intent ledger operation failed. Check ~/.ashlr-runs/intent permissions and retry.';
    if (json) emit(true, { ok: false, error: message }); else console.error(message);
    return 2;
  }
}
