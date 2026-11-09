import { linkMergedPull, markShipped, MAX_RELEASE_REF } from '../core/intent/evidence.js';
import { normalizeRq, validRepo } from '../core/intent/schema.js';
import { noteShippedRelease } from '../core/intent/release.js';
import { readLedger, writeLedger } from '../core/intent/store.js';

const usage = 'Usage: ashlr fleet intent-evidence merged --repo owner/name --number N --title text [--branch text] [--at timestamp] [--apply] [--json]\n       ashlr fleet intent-evidence shipped --release id [--rq key[,key...]] [--notes text] [--at timestamp] [--apply] [--json]';

/** Record caller-supplied evidence; this command does not verify a merge or release. */
export async function cmdFleetIntentEvidence(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const invalid = (): number => { console.error(`error: invalid intent-evidence arguments\n${usage}`); return 2; };
  const action = args[0];
  if (action !== 'merged' && action !== 'shipped') return invalid();
  const allowed = action === 'merged' ? ['--repo', '--number', '--title', '--branch', '--at'] : ['--release', '--rq', '--notes', '--at'];
  const values = new Map<string, string>();
  let apply = false, json = false;
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (key === '--json' && !json) { json = true; continue; }
    if (!allowed.includes(key) || values.has(key)) return invalid();
    const value = args[++i];
    if (!value || value.startsWith('--') || !value.trim()) return invalid();
    values.set(key, value);
  }
  const at = values.get('--at') ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || Number.isNaN(Date.parse(at))) return invalid();
  const repo = values.get('--repo') ?? '';
  const numberText = values.get('--number') ?? '';
  const number = Number(numberText);
  const title = values.get('--title') ?? '';
  const release = values.get('--release') ?? '';
  let rq: string[] = [];
  if (action === 'merged') {
    if (!validRepo(repo) || !/^[1-9]\d*$/.test(numberText) || !Number.isSafeInteger(number) || !title.trim()) return invalid();
  } else {
    if (!release.trim() || release.replace(/[\r\n]+/g, ' ').trim().length > MAX_RELEASE_REF || (!values.has('--rq') && !values.has('--notes'))) return invalid();
    try { rq = values.has('--rq') ? values.get('--rq')!.split(',').map(normalizeRq) : []; }
    catch { return invalid(); }
  }
  try {
    const note = { release, rq, notes: values.get('--notes') };
    let matches: { id: string; status: string }[];
    if (action === 'shipped' && apply) {
      matches = (await noteShippedRelease(note, { now: at })).matches;
    } else {
      const ledger = await readLedger();
      const matched = action === 'merged'
        ? linkMergedPull(ledger, { repo, number, title, branch: values.get('--branch') }, at)
        : markShipped(ledger, note, at);
      if (action === 'merged' && apply && matched.length > 0) await writeLedger(ledger);
      matches = matched.map(({ id, status }) => ({ id, status }));
    }
    const result = { dryRun: !apply, applied: apply && matches.length > 0, matches };
    if (json) console.log(JSON.stringify(result));
    else console.log(`${result.applied ? 'Recorded' : 'Preview'}: ${result.matches.length} matched directive(s)${result.matches.map(({ id, status }) => `\n${id}: ${status}`).join('')}`);
    return 0;
  } catch (error) {
    console.error(`intent-evidence: ${error instanceof Error ? error.message : 'operation failed'}`);
    return 1;
  }
}
