/** `phm org` - declarative co-founder org model. Thin: logic lives in src/core/org/org.ts. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetOrgTree } from '../core/fleet/org-tree.js';
import { joinOrg, joinsDir, loadOrg, orgFile, parseQueue, planOrg, readJoins, OrgError } from '../core/org/org.js';

export const ORG_USAGE = `Usage: phm org [--json] [--text] [--minutes N]
       phm org <show|join|plan> [--file <org.toml>] [--json]
  (no verb)                     The live organization as a fleet.org.v1 JSON tree: the leader, its planners (executor,
                                Core orchestrator, main guardian, comms), each lane, each job with tier, age and goal.
                                Every node has a provider, a model, a state (running, idle, held, done, unknown) and what it
                                is doing in plain words. Lanes add running, target, queued and pool usage. A job whose
                                publish record has a RESULT line is done, not running.
                                JSON adds "groups": the Map's "By org" tree (fleet.org-groups.v1: leader, lanes, jobs, Guardian,
                                Loops, unassigned), or null when the live map could not be read.
                                JSON is the default (--json says so explicitly); --text prints it for people.
                                --minutes N sets the message window (1..1440, default 60).
                                A fact no source reported is null in JSON and "unknown" in text, never 0.
  show                          The org: members, agents, machines, lanes, shares and reporting lines
  join --member <id> --machine <id> [--lane <lane>[=<share>]]...
                                Run on your own machine. Opts in only the lanes you name (share can only be lowered).
                                Nothing is sent and no provider auth is read; sign in to your own CLIs here.
  plan [--queue <jobs.json>]    Propose queue assignments and agent roles within each member's contributed limits
Default file: ~/.ashlr/org.toml (example: docs/examples/org.toml). Guide: docs/AGENT-NETWORK.md#team-org

  With --json every failure prints {"schema":"org.error.v1","command","error":{"code","message"}}
  on stdout (code: usage | rejected | error) instead of "phm org: ..." on stderr; exit codes are unchanged.`;

function take(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const v = args[i + 1];
    args.splice(i, 2);
    // A flag where the value belongs is a missing value, never a value.
    if (v === undefined || v.startsWith('--')) throw new OrgError(`${name} needs a value.`);
    out.push(v);
  }
  return out;
}

/** Flags that take exactly one value refuse a repeat instead of silently keeping the first. */
function one(args: string[], name: string): string | undefined {
  const values = take(args, name);
  if (values.length > 1) throw new OrgError(`${name} was given more than once.`);
  return values[0];
}

/** Once every known flag is taken nothing may remain: a stray word or an unknown
 * flag is refused, never ignored — a typo must not read as "no lanes" or "no queue". */
function noLeftovers(args: string[]): void {
  if (args.length) throw new OrgError(`Unexpected argument${args.length === 1 ? '' : 's'} ${args.map((a) => `'${a}'`).join(' ')}. Run: phm org --help`);
}

/** Argument-shape failures: exit 2. Under --json the caller gets the parseable
 * envelope on stdout; text mode keeps the full usage on stderr. */
function orgUsage(json: boolean, command: string, message = 'Invalid org arguments'): number {
  if (json) {
    console.log(JSON.stringify({ schema: 'org.error.v1', command, error: { code: 'usage', message: `${message}. Run: phm org --help` } }));
    return 2;
  }
  console.error(ORG_USAGE);
  return 2;
}

/** Operational and validation failures: exit 1. OrgError is the org model
 * refusing the request (bad member, machine, lane, share, file or queue);
 * anything else is an operational failure. Messages are fixed operator-facing
 * strings — no argument values or file contents are echoed. */
function orgFailure(json: boolean, command: string, err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({ schema: 'org.error.v1', command,
      error: { code: err instanceof OrgError ? 'rejected' : 'error', message } }));
    return 1;
  }
  console.error(`phm org: ${message}`);
  return 1;
}

/** Bare `phm org`: the live tree the Fleet map draws. Reads only; the builder is src/core/fleet/org-tree.ts. */
async function liveOrg(args: string[]): Promise<number> {
  const asText = args.includes('--text'), asJson = args.includes('--json'), at = args.indexOf('--minutes');
  const rest = args.filter((arg, i) => arg !== '--text' && arg !== '--json' && i !== at && (at < 0 || i !== at + 1));
  if (rest.length || (at >= 0 && args[at + 1] === undefined)) return orgUsage(asJson, 'org');
  const [{ readFleetOrgMap }, { mapWindowMinutes }, { renderOrgTreeText }, { sanitizePublicJson }] = await Promise.all([
    import('../core/verse/fleet-org-map-api.js'), import('../core/fleet/org-map.js'), import('../core/fleet/org-tree.js'), import('../core/util/public-json.js')]);
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  const tree = sanitizePublicJson((await readFleetOrgMap(mapWindowMinutes(at < 0 ? undefined : args[at + 1]))).tree) as FleetOrgTree;
  if (asText) { console.log(renderOrgTreeText(tree)); return 0; }
  // `groups` is the tree the Map's "By org" view draws (fleet.org-groups.v1: leader, lanes, jobs, guardian, loops, unassigned).
  // An unreadable live map is null, not an empty tree, and does not fail the rest.
  const { readFleetOrgGroups } = await import('../core/verse/fleet-org-groups-api.js');
  const groups = await readFleetOrgGroups().then(value => sanitizePublicJson(value), () => null);
  console.log(JSON.stringify({ ...tree, groups }, null, 2));
  return 0;
}

export async function cmdOrg(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) { console.log(ORG_USAGE); return 0; }
  // `--json` is a boolean flag and a standalone `--json` token can never be a
  // flag value (values starting with `--` are refused), so argv alone proves
  // the caller asked for JSON even when parsing fails first.
  const json = args.includes('--json');
  if (!args.some((arg, i) => !arg.startsWith('-') && args[i - 1] !== '--minutes' && args[i - 1] !== '--file')) {
    try { return await liveOrg(args); } catch (err) { return orgFailure(json, 'org', err); }
  }
  if (json) args.splice(args.indexOf('--json'), 1);
  const print = (v: unknown, text: string) => { console.log(json ? JSON.stringify(v, null, 2) : text); return 0; };
  let command = 'org';
  try {
    const file = one(args, '--file') ?? orgFile();
    const [sub, ...rest] = args;
    if (sub !== 'show' && sub !== 'join' && sub !== 'plan') {
      return orgUsage(json, 'org', typeof sub === 'string' && !sub.startsWith('-') ? `Unknown org command '${sub}'` : undefined);
    }
    command = sub;
    const org = loadOrg(file);
    if (sub === 'show') {
      noLeftovers(rest);
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
      const member = one(rest, '--member'), machine = one(rest, '--machine');
      const laneArgs = take(rest, '--lane');
      noLeftovers(rest);
      if (!member || !machine) throw new OrgError('join needs --member and --machine.');
      // --lane takes <lane> or <lane>=<share>; a second '=', an empty name or a
      // non-numeric share is a usage error, and the same lane is never repeated.
      const optIn = laneArgs.map((s) => {
        const eq = s.indexOf('=');
        if (eq >= 0 && s.indexOf('=', eq + 1) >= 0) throw new OrgError(`--lane takes <lane> or <lane>=<share>: '${s}'`);
        const name = eq < 0 ? s : s.slice(0, eq);
        const shareText = eq < 0 ? undefined : s.slice(eq + 1);
        if (name === '') throw new OrgError(`--lane needs a lane name: '${s}'`);
        if (shareText !== undefined && (shareText.trim() === '' || !Number.isFinite(Number(shareText)))) {
          throw new OrgError(`--lane share must be a number: '${s}'`);
        }
        return { lane: name, share: shareText === undefined ? undefined : Number(shareText) };
      });
      const seen = new Set<string>();
      for (const o of optIn) {
        if (seen.has(o.lane)) throw new OrgError(`--lane ${o.lane} was given more than once.`);
        seen.add(o.lane);
      }
      const r = joinOrg(org, { member, machine, optIn });
      const recordFile = join(joinsDir(), `${r.member}.${r.machine}.json`);
      return print({ schema: 'org.join.v1', record: r, dir: joinsDir(), recordFile }, `${r.member} joined on ${r.machine} with ${r.lanes.length ? r.lanes.map((l) => `${l.lane} ${l.share}%`).join(', ') : 'no lanes (nothing contributed)'}.\nRecord: ${recordFile}\nSign in to your own provider CLIs on this machine; nothing was sent and no auth was read. Copy the record file into the leader's joins directory to count this machine.`);
    }
    const queueFile = one(rest, '--queue');
    noLeftovers(rest);
    const queue = queueFile ? parseQueue(readFileSync(queueFile, 'utf8')) : [];
    let view = null;
    try { view = await (await import('../core/fabric/resource-view-store.js')).readResourceView(); } catch { /* unknown usage is planned conservatively */ }
    const plan = planOrg(org, readJoins(), view, queue);
    return print(plan, [`Plan for ${plan.leader}: ${plan.assignments.length} assigned, ${plan.unassigned.length} unassigned, ${plan.held.length} lanes held`,
      ...plan.assignments.map((a) => `  ${a.job} -> ${a.agent} (${a.member}/${a.lane}, ~${a.costPct}%)`),
      ...plan.unassigned.map((u) => `  ! ${u.job}: ${u.reason}`)].join('\n'));
  } catch (err) {
    return orgFailure(json, command, err);
  }
}
