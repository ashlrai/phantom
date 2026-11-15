/** `phm org` - declarative co-founder org model. Thin: logic lives in src/core/org/org.ts. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { joinOrg, joinsDir, loadOrg, orgFile, parseQueue, planOrg, readJoins, OrgError } from '../core/org/org.js';
import { orgBoardView, orgRunsRoot, proposeAgent, readAgentPlane, syncAgentPlane } from '../core/org/agent-plane.js';
import { sizeWorkerSession } from '../core/org/session-economics.js';

export const ORG_USAGE = `Usage: phm org <show|join|plan|agents|propose|sync> [--json]
  agents [id] [--runs <dir>] [--vitals <json>]  Board view or one role; optional measured session sizing
  propose --input <json> [--apply] [--runs <dir>]  Ledger a proposal; apply edits org metadata only
  sync [--runs <dir>]            Retry pending local org membership events
  show                          The org: members, agents, machines, lanes, shares and reporting lines
  join --member <id> --machine <id> [--lane <lane>[=<share>]]...
                                Run on your own machine. Opts in only the lanes you name (share can only be lowered).
                                Nothing is sent and no provider auth is read; sign in to your own CLIs here.
  plan [--queue <jobs.json>]    Propose queue assignments and agent roles within each member's contributed limits
Default file: ~/.ashlr/org.toml (example: docs/examples/org.toml). Guide: docs/AGENT-NETWORK.md#team-org`;

function take(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) { const v = args[i + 1]; args.splice(i, 2); if (v === undefined) throw new OrgError(`${name} needs a value.`); out.push(v); }
  return out;
}

export async function cmdOrg(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) { console.log(ORG_USAGE); return 0; }
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  const print = (v: unknown, text: string) => { console.log(json ? JSON.stringify(v, null, 2) : text); return 0; };
  try {
    if (['agents', 'propose', 'sync'].includes(args[0] ?? '')) {
      const sub = args.shift();
      const one = (flag: string) => { const values = take(args, flag); if (values.length > 1 || values[0]?.startsWith('--')) throw new OrgError(`Invalid ${flag}.`); return values[0]; };
      const scratch = one('--runs'), root = resolve(scratch ?? orgRunsRoot());
      const busRoot = scratch ? join(root, 'bus') : undefined;
      const input = one('--input'), vitals = one('--vitals');
      const apply = args.includes('--apply'); if (apply) args.splice(args.indexOf('--apply'), 1);
      if ((sub !== 'agents' && args.length) || (sub === 'agents' && (args.length > 1 || args[0]?.startsWith('-'))) ||
          (sub !== 'propose' && (input || apply)) || (sub !== 'agents' && vitals)) throw new OrgError('Invalid org plane arguments.');
      if (sub === 'propose' && !input) throw new OrgError('propose needs --input.');
      const readJson = (file: string): unknown => {
        try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new OrgError('Cannot read JSON input.'); }
      };
      const plane = sub === 'propose' ? proposeAgent(readJson(input!), apply, root, busRoot) : sub === 'sync' ? syncAgentPlane(root, busRoot) : readAgentPlane(root);
      const agent = args[0] ? plane.agents.find(role => role.id === args[0]) : undefined;
      if (args[0] && !agent) throw new OrgError('Unknown agent.');
      const value = { ...orgBoardView(plane), ...(agent ? { agents: [agent] } : {}), ...(vitals ? { sessionAdvice: sizeWorkerSession(readJson(vitals)) } : {}) };
      return print(value, JSON.stringify(value, null, 2));
    }
    const file = take(args, '--file')[0] ?? orgFile();
    const [sub, ...rest] = args;
    if (sub !== 'show' && sub !== 'join' && sub !== 'plan') { console.error(ORG_USAGE); return 2; }
    const org = loadOrg(file);
    if (sub === 'show') {
      const joins = readJoins();
      const lines = [`Org (leader ${org.leader})`];
      for (const m of org.members) {
        lines.push(`  ${m.name}${m.nickname ? ` "${m.nickname}"` : ''} [${m.id}] ${m.role}`);
        for (const c of m.contributions) lines.push(`    lane ${c.lane}: ${c.share}% declared, ${joins.some((j) => j.member === m.id && j.lanes.some((l) => l.lane === c.lane)) ? 'opted in' : 'not opted in'}`);
        for (const a of m.agents) lines.push(`    agent ${a.id} (${a.lane} on ${a.machine}; ${a.roles.join('/')}) reports to ${a.reports_to ?? 'nobody'}`);
      }
      return print({ schema: 'org.show.v1', file, org, joins }, lines.join('\n'));
    }
    if (sub === 'join') {
      const member = take(rest, '--member')[0], machine = take(rest, '--machine')[0];
      if (!member || !machine) throw new OrgError('join needs --member and --machine.');
      const optIn = take(rest, '--lane').map((s) => { const [lane = '', share] = s.split('='); return { lane, share: share === undefined ? undefined : Number(share) }; });
      const r = joinOrg(org, { member, machine, optIn });
      return print({ schema: 'org.join.v1', record: r, dir: joinsDir() }, `${r.member} joined on ${r.machine} with ${r.lanes.length ? r.lanes.map((l) => `${l.lane} ${l.share}%`).join(', ') : 'no lanes (nothing contributed)'}.\nSign in to your own provider CLIs on this machine; nothing was sent and no auth was read.`);
    }
    const queueFile = take(rest, '--queue')[0];
    const queue = queueFile ? parseQueue(readFileSync(queueFile, 'utf8')) : [];
    let view = null;
    try { view = await (await import('../core/fabric/resource-view-store.js')).readResourceView(); } catch { /* unknown usage is planned conservatively */ }
    const plan = planOrg(org, readJoins(), view, queue);
    return print(plan, [`Plan for ${plan.leader}: ${plan.assignments.length} assigned, ${plan.unassigned.length} unassigned, ${plan.held.length} lanes held`,
      ...plan.assignments.map((a) => `  ${a.job} -> ${a.agent} (${a.member}/${a.lane}, ~${a.costPct}%)`),
      ...plan.unassigned.map((u) => `  ! ${u.job}: ${u.reason}`)].join('\n'));
  } catch (err) {
    console.error(`phm org: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
