import { cmdFleetIntentRead } from './fleet-intent-read.js';
import { cmdFleetIntentEdit } from './fleet-intent-edit.js';
import { cmdFleetIntentImport } from './fleet-intent-import.js';
import { sweepStale } from '../core/intent/sweep.js';
import { linkMergedPull, MAX_RELEASE_REF } from '../core/intent/evidence.js';
import { noteShippedRelease } from '../core/intent/release.js';
import { readLedger, writeLedger } from '../core/intent/store.js';
import { normalizeRq, validRepo } from '../core/intent/schema.js';

const usage = `Usage: phm fleet intent list [--status status] [--json]
       phm fleet intent get <id> [--json]
       phm fleet intent add --title text --source label [--rq key]... [--json]
       phm fleet intent update <id> [--status status] [--rq key]... [--evidence ref] [--notes text] [--json]
       phm fleet intent import <file> [more files...] [--json]
       phm fleet intent stale [--apply] [--json]
       phm fleet intent link --repo owner/name --number n --title text [--branch name] [--url url] [--json]
       phm fleet intent ship --release id [--notes text] [--rq key]... [--json]
Stale recommends supersession; it does not automatically close directives.
Link and ship record caller-reported evidence, not independent verification.`;

export async function cmdFleetIntent(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const json = rest.includes('--json');
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    return 2;
  };
  if (!verb || ['help', '--help', '-h'].includes(verb)) {
    if (args.length > 1 && !(args.length === 2 && args[1] === '--json')) return fail('Invalid arguments.');
    console.log(args.includes('--json') ? JSON.stringify({ usage }) : usage);
    return 0;
  }
  if (verb === 'list' || verb === 'get') return cmdFleetIntentRead([verb, ...rest]);
  if (verb === 'add' || verb === 'update') {
    return cmdFleetIntentEdit([verb, ...rest.map(arg => arg === '--notes' && verb === 'update' ? '--note' : arg)]);
  }
  if (verb === 'import') return cmdFleetIntentImport(rest);
  if (verb === 'stale') {
    if (rest.some(arg => arg !== '--json' && arg !== '--apply') || new Set(rest).size !== rest.length) return fail('Invalid arguments.');
    try {
      const result = await sweepStale({ apply: rest.includes('--apply') });
      if (json) console.log(JSON.stringify({ ok: true, ...result }));
      else for (const row of result.stale) console.log(`${row.id}  ${row.action}  ${row.status}  ${row.title}`);
      return 0;
    } catch { return fail('Intent sweep failed.'); }
  }
  if (verb !== 'link' && verb !== 'ship') return fail('Unknown intent command.');
  const allowed = verb === 'link' ? ['--repo', '--number', '--title', '--branch', '--url'] : ['--release', '--notes', '--rq'];
  const values = new Map<string, string>();
  const rq: string[] = [];
  let seenJson = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--json' && !seenJson) { seenJson = true; continue; }
    if (!allowed.includes(key) || (key !== '--rq' && values.has(key))) return fail('Invalid arguments.');
    const value = rest[++i];
    if (!value || value.startsWith('--') || !value.trim()) return fail('Invalid arguments.');
    if (key === '--rq') rq.push(value); else values.set(key, value);
  }
  try {
    let updated: number;
    if (verb === 'link') {
      const repo = values.get('--repo') ?? '';
      const numberText = values.get('--number') ?? '';
      const number = Number(numberText);
      const title = values.get('--title') ?? '';
      if (!validRepo(repo) || !/^[1-9]\d*$/.test(numberText) || !Number.isSafeInteger(number) || !title.trim()) return fail('Invalid pull evidence.');
      const ledger = await readLedger();
      const matches = linkMergedPull(ledger, { repo, number, title, branch: values.get('--branch'), url: values.get('--url') }, new Date().toISOString());
      if (matches.length) await writeLedger(ledger);
      updated = matches.length;
    } else {
      const release = values.get('--release') ?? '';
      if (!release.trim() || release.replace(/[\r\n]+/g, ' ').trim().length > MAX_RELEASE_REF) return fail('Invalid release.');
      const keys = rq.map(normalizeRq);
      updated = (await noteShippedRelease({ release, notes: values.get('--notes'), rq: keys })).updated;
    }
    if (json) console.log(JSON.stringify({ ok: true, updated }));
    else console.log(`${verb === 'link' ? 'Linked' : 'Shipped'} ${updated}.`);
    return 0;
  } catch { return fail('Intent evidence operation failed.'); }
}
