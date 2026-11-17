import {
  assignSpecialist, configureSpecialistIdentity, findSpecialist, loadSpecialistRoster, saveSpecialistRoster,
  specialistRosterDirectory, withSpecialistRosterLock,
} from '../core/fleet/roster.js';
import { appendSpecialistOutcome } from '../core/fleet/specialist-memory.js';
import { defaultSpecialistJobsPath, loadSpecialistIdentity } from '../core/fleet/specialist-identity.js';

const USAGE = 'phm fleet roster list|show <id>|identity <id>|configure <id> <identity-json>|assign <id> <domain>|note <id> <text> [--json]';
export interface FleetRosterDeps {
  directory?: string;
  jobsPath?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export async function cmdFleetRoster(args: string[], deps: FleetRosterDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) { out(USAGE); return 0; }
  const [verb, id, text] = rest;
  const arity = verb === 'list' ? 1 : ['show', 'identity'].includes(verb ?? '') ? 2 : ['assign', 'note', 'configure'].includes(verb ?? '') ? 3 : 0;
  if (!arity || rest.length !== arity || args.filter(arg => arg === '--json').length > 1
    || rest.some(arg => arg.startsWith('-'))) {
    err(json ? JSON.stringify({ ok: false, error: 'invalid-argument', usage: USAGE }) : USAGE);
    return 2;
  }
  const directory = deps.directory ?? specialistRosterDirectory();
  try {
    if (verb === 'identity') {
      out(JSON.stringify(await loadSpecialistIdentity(id!, directory, deps.jobsPath ?? defaultSpecialistJobsPath(directory)), null, json ? undefined : 2));
      return 0;
    }
    const run = async (): Promise<unknown> => {
      let roster = await loadSpecialistRoster(directory);
      if (verb === 'list') return roster;
      if (verb === 'assign') {
        roster = assignSpecialist(roster, id!, text!);
        await saveSpecialistRoster(roster, directory);
        roster = await loadSpecialistRoster(directory);
      }
      if (verb === 'configure') {
        roster = configureSpecialistIdentity(roster, id!, JSON.parse(text!));
        await saveSpecialistRoster(roster, directory);
        roster = await loadSpecialistRoster(directory);
      }
      const specialist = findSpecialist(roster, id!);
      if (verb === 'note') {
        await appendSpecialistOutcome(specialist, { job: specialist.currentJob ?? 'manual', outcome: 'note', summary: text! }, directory);
      }
      return { specialist };
    };
    const result = ['assign', 'note', 'configure'].includes(verb!) ? await withSpecialistRosterLock(directory, run) : await run();
    out(JSON.stringify(result, null, json ? undefined : 2));
    return 0;
  } catch {
    // Never include filesystem exceptions or user-provided text in diagnostics.
    err(json ? JSON.stringify({ ok: false, error: 'roster-operation-failed' }) : 'Specialist roster operation failed.');
    return 1;
  }
}
