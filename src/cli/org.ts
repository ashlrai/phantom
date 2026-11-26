/** `phm org` - declarative co-founder org model. Thin: logic lives in src/core/org/org.ts. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetOrgTree } from '../core/fleet/org-tree.js';
import { droppedJoinLanes, initOrg, joinOrg, joinsDir, loadOrg, openJoinLanes, orgFile, parseQueue, planOrg, readJoins, OrgError } from '../core/org/org.js';

export const ORG_USAGE = `Usage: phm org [--json] [--text] [--minutes N]
       phm org <show|join|plan|init> [--file <org.toml>] [--json]
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
                                A re-join replaces this machine's opt-ins; dropped lanes are listed. Nothing is sent
                                and no provider auth is read; sign in to your own CLIs here.
  plan [--queue <jobs.json>]    Propose queue assignments and agent roles within each member's contributed limits
  init --member <id> --machine <id> [--name <name>] [--lane <lane>[=<share>]]...
                                Write a starter org.toml (default ~/.ashlr/org.toml, or --file)
                                declaring <member> as leader (founder) of a new org on <machine>.
                                A bare --lane declares share 100; =<share> sets 0-100. Refuses to
                                overwrite an existing file. Add members, agents and lanes by editing
                                the file; nothing is sent and no auth is read.
Default file: ~/.ashlr/org.toml (create one with init, or use a copy of the leader's file). Guide: docs/AGENT-NETWORK.md#team-org

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
  const minutesArg = at < 0 ? undefined : args[at + 1];
  const rest = args.filter((arg, i) => arg !== '--text' && arg !== '--json' && i !== at && (at < 0 || i !== at + 1));
  if (rest.length || (at >= 0 && minutesArg === undefined)) return orgUsage(asJson, 'org');
  const [{ readFleetOrgMap }, { mapWindowMinutesOrNull }, { renderOrgTreeText }, { sanitizePublicJson }] = await Promise.all([
    import('../core/verse/fleet-org-map-api.js'), import('../core/fleet/org-map.js'), import('../core/fleet/org-tree.js'), import('../core/util/public-json.js')]);
  // A window that is not a whole number of minutes in range is bad usage (exit 2),
  // the same refusal --window and --minutes give on the fleet verbs — never the
  // operational 'error' a thrown mapWindowMinutes would surface as.
  const minutes = mapWindowMinutesOrNull(minutesArg);
  if (minutes === null) return orgUsage(asJson, 'org', '--minutes must be a whole number from 1 to 1440');
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  const tree = sanitizePublicJson((await readFleetOrgMap(minutes)).tree) as FleetOrgTree;
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
    if (sub !== 'show' && sub !== 'join' && sub !== 'plan' && sub !== 'init') {
      return orgUsage(json, 'org', typeof sub === 'string' && !sub.startsWith('-') ? `Unknown org command '${sub}'` : undefined);
    }
    command = sub;
    if (sub === 'init') {
      const member = one(rest, '--member'), machine = one(rest, '--machine'), name = one(rest, '--name');
      const laneArgs = take(rest, '--lane');
      noLeftovers(rest);
      if (!member || !machine) throw new OrgError('init needs --member and --machine.');
      // Same flag shape as join's --lane, except a bare lane declares the full share (100)
      // and the share itself is bounded by the schema's 0-100, not a prior declaration.
      const lanes = laneArgs.map((s) => {
        const eq = s.indexOf('=');
        if (eq >= 0 && s.indexOf('=', eq + 1) >= 0) throw new OrgError(`--lane takes <lane> or <lane>=<share>: '${s}'`);
        const laneName = eq < 0 ? s : s.slice(0, eq);
        const shareText = eq < 0 ? undefined : s.slice(eq + 1);
        if (laneName === '') throw new OrgError(`--lane needs a lane name: '${s}'`);
        const share = shareText === undefined ? 100 : Number(shareText);
        if (shareText !== undefined && (shareText.trim() === '' || !Number.isFinite(share) || share < 0 || share > 100)) {
          throw new OrgError(`--lane share must be a number from 0 to 100: '${s}'`);
        }
        return { lane: laneName, share };
      });
      const seenLanes = new Set<string>();
      for (const l of lanes) {
        if (seenLanes.has(l.lane)) throw new OrgError(`--lane ${l.lane} was given more than once.`);
        seenLanes.add(l.lane);
      }
      const r = initOrg({ member, machine, ...(name === undefined ? {} : { name }), lanes }, file);
      const m = r.org.members[0]!;
      const laneText = m.contributions.length ? m.contributions.map((c) => `${c.lane} ${c.share}%`).join(', ') : 'none';
      return print({ schema: 'org.init.v1', file: r.file, leader: r.org.leader, member: m.id, machine: m.machines[0]!.id, lanes: m.contributions },
        `Wrote ${r.file}: ${r.org.leader} leads ${m.name} on ${m.machines[0]!.id} with lanes ${laneText}.\nEdit the file to add members, agents and lanes. Each machine opts in with:\n  phm org join --member ${m.id} --machine ${m.machines[0]!.id}${m.contributions.length ? ` --lane ${m.contributions.map((c) => c.lane).join(' --lane ')}` : ''} --json\nThe leader plans with: phm org plan --json`);
    }
    const org = loadOrg(file);
    if (sub === 'show') {
      noLeftovers(rest);
      const joins = readJoins();
      const lines = [`Org (leader ${org.leader})`];
      for (const m of org.members) {
        lines.push(`  ${m.name}${m.nickname ? ` "${m.nickname}"` : ''} [${m.id}] ${m.role}`);
        for (const c of m.contributions) {
          // Opt-in counts only the join records this machine holds; naming the
          // machines behind it keeps a member's partial view (its own records
          // only) from reading as the org's admitted set.
          const machines = [...new Set(joins.filter((j) => j.member === m.id && j.lanes.some((l) => l.lane === c.lane)).map((j) => j.machine))].sort();
          lines.push(`    lane ${c.lane}: ${c.share}% declared, ${machines.length ? `opted in on ${machines.join(', ')}` : 'not opted in'}`);
        }
        for (const a of m.agents) lines.push(`    agent ${a.id} (${a.lane} on ${a.machine}; ${a.roles.join('/')}) reports to ${a.reports_to ?? 'nobody'}`);
      }
      lines.push(`Opt-in counts join records held on this machine (${joinsDir()}); each machine sees only its own joins directory.`);
      return print({ schema: 'org.show.v1', file, org, joins, joinsDir: joinsDir() }, lines.join('\n'));
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
      // Read the machine's current record before joinOrg replaces it, so a re-join that
      // stops naming a lane reports the opt-out instead of dropping it silently.
      const prior = readJoins().find((j) => j.member === member && j.machine === machine);
      const r = joinOrg(org, { member, machine, optIn });
      const recordFile = join(joinsDir(), `${r.member}.${r.machine}.json`);
      const dropped = droppedJoinLanes(prior, r);
      const droppedNote = dropped.length
        ? `This machine no longer opts in: ${dropped.map((l) => `${l.lane} (was ${l.share}%)`).join(', ')}. Name the lane again with --lane to restore it.\n`
        : '';
      // Declared lanes this record has not opted into — a join with no --lane
      // contributes nothing, and a partial one leaves the rest unnamed. The
      // re-join hint keeps every current opt-in at its recorded share and adds
      // each open lane at the declared share a bare --lane grants, because a
      // re-join replaces the whole record: a bare "--lane <new>" would silently
      // drop the rest. Ids, lane names and shares are schema-validated tokens,
      // safe to inline like joinHintCommand's profile values.
      const open = openJoinLanes(org, r);
      const openNote = open.length
        ? `Not opted in on this machine: ${open.map((l) => `${l.lane} (declared ${l.share}%)`).join(', ')}. ` +
          `Opt in by re-joining — it replaces this record, so name every lane to keep: ` +
          `phm org join --member ${r.member} --machine ${r.machine}` +
          [...r.lanes.map((l) => ` --lane ${l.lane}=${l.share}`), ...open.map((l) => ` --lane ${l.lane}`)].join('') + '.\n'
        : '';
      return print({ schema: 'org.join.v1', record: r, dir: joinsDir(), recordFile, droppedLanes: dropped, availableLanes: open }, `${r.member} joined on ${r.machine} with ${r.lanes.length ? r.lanes.map((l) => `${l.lane} ${l.share}%`).join(', ') : 'no lanes (nothing contributed)'}.\n${droppedNote}${openNote}Record: ${recordFile}\nSign in to your own provider CLIs on this machine; nothing was sent and no auth was read. Copy the record file into the leader's joins directory to count this machine.`);
    }
    const queueFile = one(rest, '--queue');
    noLeftovers(rest);
    const queue = queueFile ? parseQueue(readFileSync(queueFile, 'utf8')) : [];
    let view = null;
    try { view = await (await import('../core/fabric/resource-view-store.js')).readResourceView(); } catch { /* unknown usage is planned conservatively */ }
    const [{ readFleetResourcePlan }, { runsRoot }] = await Promise.all([
      import('../core/usage/resource-live/fleet-plan.js'), import('../core/metrics/loop-collect.js'),
    ]);
    const now = new Date();
    const capacity = await readFleetResourcePlan(runsRoot(), now.getTime()).catch(() => null);
    const plan = planOrg(org, readJoins(), view, queue, now, capacity?.lanes);
    // Text mode names each held lane and the join that opts it in; the JSON plan
    // already carries the same held rows, so --json consumers lose nothing.
    const heldLines = plan.held.map((h) => {
      const machines = org.members.find((m) => m.id === h.member)?.machines.map((x) => x.id) ?? [];
      const machineArg = machines.length === 1 ? machines[0]! : machines.length ? `<${machines.join('|')}>` : null;
      const fix = machineArg === null ? 'add a machine for this member in org.toml before join'
        : `on that member's machine run: phm org join --member ${h.member} --machine ${machineArg} --lane ${h.lane}`;
      return `  held ${h.member}/${h.lane}: ${h.reason} — ${fix}`;
    });
    // The plan covers only the join records this machine holds; a member's
    // machine sees a partial org, so say which records counted.
    return print({ ...plan, joinsDir: joinsDir() }, [`Plan for ${plan.leader}: ${plan.assignments.length} assigned, ${plan.unassigned.length} unassigned, ${plan.held.length} lanes held`,
      ...plan.assignments.map((a) => `  ${a.job} -> ${a.agent} (${a.member}/${a.lane}, ~${a.costPct}%)`),
      ...plan.unassigned.map((u) => `  ! ${u.job}: ${u.reason}`),
      ...heldLines,
      `Opt-in counts join records held on this machine (${joinsDir()}); the plan covers only those records.`].join('\n'));
  } catch (err) {
    return orgFailure(json, command, err);
  }
}
