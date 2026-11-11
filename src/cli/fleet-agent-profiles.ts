import { homedir } from 'node:os';
import {
  agentProfileVersions,
  listAgentProfiles,
  readAgentProfile,
} from '../core/agents/agent-profile.js';

const usage = 'Usage: ashlr fleet agent-profiles list|show <id>|validate <id>|versions <id> [--json]';
const failure = 'Agent profile operation failed. Use ashlr fleet agent-profiles list|show <id>|validate <id>|versions <id> [--json].';

export interface AgentProfilesCliDeps {
  home?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const VERBS = new Set(['list', 'show', 'validate', 'versions']);

/** Read-only view of portable agent profiles; writes nothing and grants no authority. */
export async function cmdFleetAgentProfiles(
  args: string[],
  deps: AgentProfilesCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  const home = deps.home ?? homedir();
  const fail = (json: boolean): number => {
    err(json ? JSON.stringify({ ok: false, error: failure }) : `${failure}\n${usage}`);
    return 2;
  };

  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    out(usage);
    return 0;
  }

  const jsonFlags = args.filter(arg => arg === '--json').length;
  const json = jsonFlags > 0;
  if (jsonFlags > 1) return fail(true);
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === '--json') continue;
    if (arg.startsWith('-')) return fail(json);
    rest.push(arg);
  }

  const [verb, id, ...extra] = rest;
  if (verb === undefined || !VERBS.has(verb)) return fail(json);
  if (verb === 'list' ? rest.length !== 1 : id === undefined || extra.length !== 0) return fail(json);

  try {
    if (verb === 'list') {
      out(JSON.stringify({ profiles: await listAgentProfiles(home) }));
    } else if (verb === 'versions') {
      out(JSON.stringify({ id, versions: await agentProfileVersions(id!, home) }));
    } else if (verb === 'validate') {
      const profile = await readAgentProfile(id!, home);
      out(JSON.stringify({ id, valid: true, version: profile.version }));
    } else {
      out(JSON.stringify({ profile: await readAgentProfile(id!, home) }));
    }
    return 0;
  } catch {
    return fail(json);
  }
}
