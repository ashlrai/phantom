import { agentProfileVersions, listAgentProfiles, readAgentProfile } from '../core/agents/agent-profile.js';
const usage = 'Usage: phm agents list|show <id>|validate <id>|versions <id> [--json]';
export async function cmdAgents(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest.includes('--help') || rest.includes('-h')) { console.log(usage); return 0; }
  try {
    const [verb, id] = rest;
    if (verb === 'list' && rest.length === 1) console.log(JSON.stringify({ profiles: await listAgentProfiles() }));
    else if (['show', 'validate', 'versions'].includes(verb ?? '') && id && rest.length === 2) {
      const profile = await readAgentProfile(id);
      console.log(JSON.stringify(verb === 'versions' ? { id, versions: await agentProfileVersions(id) } : verb === 'validate' ? { id, valid: true, version: profile.version } : { profile }));
    } else throw new Error();
    return 0;
  } catch {
    const error = 'Agent profile operation failed. Use phm agents list|show <id>|validate <id>|versions <id> --json. See docs/AGENT-PROFILES.md.';
    console.error(json ? JSON.stringify({ ok: false, error }) : error);
    return 2;
  }
}
