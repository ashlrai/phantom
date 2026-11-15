import { addIntent, updateIntent, type IntentAddInput, type IntentUpdateInput } from '../core/intent/edit.js';
import { IntentError, isIntentStatus, validIntentId } from '../core/intent/schema.js';

const usage = `Usage: ashlr fleet intent-edit add --title <text> --source <label> [--owner <label>] [--rq <key>]... [--status <status>] [--stale-after <ms>] [--date <iso>] [--verbatim] [--partial] [--json]
       ashlr fleet intent-edit update <id> [--title <text>] [--source <label>] [--owner <label>] [--status <status>] [--rq <key>]... [--evidence <ref> [--note <text>]] [--partial] [--json]
Records or edits a directive in the private intent ledger. A matching RQ key or title merges into the existing record.
--status and --evidence are caller-reported tracking, not authorization or proof of deployment.
ASHLR_RUNS_DIR overrides ~/.ashlr-runs.`;

const VALUE = {
  add: ['--title', '--source', '--owner', '--status', '--stale-after', '--date'],
  update: ['--title', '--source', '--owner', '--status', '--evidence', '--note'],
};
const FLAG = { add: ['--verbatim', '--partial', '--json'], update: ['--partial', '--json'] };

export async function cmdFleetIntentEdit(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const json = args.includes('--json');
  const fail = (message: string, code: number): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`intent-edit: ${message}`);
    return code;
  };
  const bad = (): number => fail('Invalid arguments. Run ashlr fleet intent-edit --help.', 2);
  const action = args[0];
  if (action !== 'add' && action !== 'update') return bad();
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const rq: string[] = [];
  let id: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (FLAG[action].includes(arg)) {
      if (flags.has(arg)) return bad();
      flags.add(arg);
    } else if (arg === '--rq') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return bad();
      rq.push(value);
    } else if (VALUE[action].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || values.has(arg)) return bad();
      values.set(arg, value);
    } else if (action === 'update' && id === undefined && validIntentId(arg)) {
      id = arg;
    } else return bad();
  }
  const status = values.get('--status');
  if (status !== undefined && !isIntentStatus(status)) return fail('Invalid status.', 2);
  const stale = values.get('--stale-after');
  if (stale !== undefined && !/^\d{1,15}$/.test(stale)) return fail('Stale timer must be milliseconds.', 2);
  try {
    if (action === 'add') {
      const title = values.get('--title');
      const source = values.get('--source');
      if (!title || !source) return fail('add needs --title and --source.', 2);
      const input: IntentAddInput = { title, source, rq, verbatim: flags.has('--verbatim'), partial: flags.has('--partial') };
      if (values.has('--owner')) input.owner = values.get('--owner');
      if (status) input.status = status as IntentAddInput['status'];
      if (stale) input.staleAfterMs = Number(stale);
      if (values.has('--date')) input.date = values.get('--date');
      const item = await addIntent(input);
      if (json) console.log(JSON.stringify({ ok: true, item }));
      else console.log(`Recorded ${item.id} [${item.status}].`);
      return 0;
    }
    if (!id) return fail('update needs a valid directive id.', 2);
    const evidence = values.get('--evidence');
    if (values.has('--note') && !evidence) return fail('--note needs --evidence.', 2);
    const patch: IntentUpdateInput = {};
    if (values.has('--title')) patch.title = values.get('--title');
    if (values.has('--source')) patch.source = values.get('--source');
    if (values.has('--owner')) patch.owner = values.get('--owner');
    if (status) patch.status = status as IntentUpdateInput['status'];
    if (rq.length) patch.rq = rq;
    if (evidence) patch.evidence = { ref: evidence, ...(values.has('--note') ? { note: values.get('--note') } : {}) };
    if (flags.has('--partial')) patch.partial = true;
    if (Object.keys(patch).length === 0) return fail('update needs at least one field to change.', 2);
    const item = await updateIntent(id, patch);
    if (json) console.log(JSON.stringify({ ok: true, item }));
    else console.log(`Updated ${item.id} [${item.status}].`);
    return 0;
  } catch (caught) {
    return fail(caught instanceof IntentError ? caught.message : 'Intent edit failed.', 1);
  }
}
