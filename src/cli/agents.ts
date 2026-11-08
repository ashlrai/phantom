import { agentProfileVersions, listAgentProfiles, readAgentProfile } from '../core/agents/agent-profile.js';
const HELP = `phm agents list [--json]
phm agents show <id> [--json]
phm agents validate <id> [--json]
phm agents versions <id> [--json]
phm agents bus contract [--json]
phm agents bus channels list|test <id> [--json]

List, show, validate and version portable agent profiles (docs/AGENT-PROFILES.md);
profiles grant no project, transport, credential or spending authority. The
\`agents bus\` verbs print the Agent Bus v2 contract (docs/AGENT-BUS.md).`;

export async function cmdAgents(
  args: string[],
  out: (text: string) => void = console.log,
  err: (text: string) => void = console.error,
): Promise<number> {
  if (!args.length || args.some(a => a === 'help' || a === '--help' || a === '-h')) {
    out(HELP);
    return 0;
  }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  try {
    const [verb, id] = rest;
    if (verb === 'list' && rest.length === 1) out(JSON.stringify({ profiles: await listAgentProfiles() }));
    else if (['show', 'validate', 'versions'].includes(verb ?? '') && id && rest.length === 2) {
      const profile = await readAgentProfile(id);
      out(JSON.stringify(verb === 'versions' ? { id, versions: await agentProfileVersions(id) } : verb === 'validate' ? { id, valid: true, version: profile.version } : { profile }));
    } else throw new Error();
    return 0;
  } catch {
    const error = 'Agent profile operation failed. Use phm agents list|show <id>|validate <id>|versions <id> --json. See docs/AGENT-PROFILES.md.';
    err(json ? JSON.stringify({ ok: false, error }) : error);
    return 2;
  }
}
