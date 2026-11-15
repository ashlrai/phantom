/** `phm whoami` and `phm org`: thin argv handling; logic lives in src/core/tenancy. */
export const WHOAMI_USAGE = 'Usage: phm whoami [--json]';
export const ORG_USAGE = 'Usage: phm org list [--json] | org add <org> [--team <team>]... [--json]';

async function run(json: boolean, usage: string, fn: (core: typeof import('../core/tenancy/index.js')) => [unknown, string]): Promise<number> {
  const core = await import('../core/tenancy/index.js');
  try {
    const [value, text] = fn(core);
    console.log(json ? JSON.stringify(value) : text);
    return 0;
  } catch (err) {
    const tenancy = err instanceof core.TenancyError;
    const error = err instanceof Error ? err.message : String(err);
    const fix = tenancy ? err.fix : usage;
    if (json) console.log(JSON.stringify({ error, fix }));
    else console.error(`error: ${error}\nfix: ${fix}`);
    return tenancy ? 1 : 2;
  }
}

export async function cmdWhoami(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${WHOAMI_USAGE}\nYour person, teams, orgs and owner scopes, from this machine's own local auth; no token is read or sent.`);
    return 0;
  }
  const json = args.includes('--json');
  return run(json, WHOAMI_USAGE, core => {
    const bad = args.find(a => a !== '--json');
    if (bad) throw new Error(`Unexpected argument "${bad}".`);
    const me = core.whoami();
    return [me, [
      `${me.person} (${me.actor === 'agent' ? 'agent acting for this person' : 'human'})`,
      `teams: ${me.teams.map(t => `${t.id} (${t.role})`).join(', ') || 'none (phm team join --team <id>)'}`,
      `orgs: ${me.orgs.join(', ') || 'none (phm org add <id>)'}`,
      `scopes: ${me.scopes.join(' ')}`,
    ].join('\n')];
  });
}

export async function cmdOrg(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${ORG_USAGE}\nOrgs group teams. list shows only orgs you belong to; add creates or extends one with you as a member.`);
    return 0;
  }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  return run(json, ORG_USAGE, core => {
    if (rest[0] === 'list' && rest.length === 1) {
      const r = core.orgList();
      return [r, r.orgs.length
        ? r.orgs.map(o => `${o.id}: members ${o.members.join(', ')}; teams ${o.teams.join(', ') || 'none'}`).join('\n')
        : `${r.person} belongs to no org. Create one: phm org add <id> [--team <team>]`];
    }
    if (rest[0] === 'add' && rest[1] && !rest[1].startsWith('--')) {
      const teams: string[] = [];
      for (let i = 2; i < rest.length; i += 2) {
        if (rest[i] !== '--team' || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error(`Unexpected argument "${rest[i]}".`);
        teams.push(rest[i + 1]!);
      }
      const r = core.orgAdd(rest[1], teams);
      return [r, `${r.action === 'unchanged' ? 'Already up to date' : r.action === 'created' ? 'Created' : 'Updated'}: org ${r.org.id} (members ${r.org.members.join(', ')}; teams ${r.org.teams.join(', ') || 'none'}).`];
    }
    throw new Error(rest.length ? `Unexpected arguments "${rest.join(' ')}".` : 'Missing subcommand.');
  });
}
