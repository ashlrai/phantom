/** `phm org` - declarative co-founder org model. Thin: logic lives in src/core/org/org.ts. */
import { readFileSync } from 'node:fs';
import type { FleetOrgTree } from '../core/fleet/org-tree.js';
import {
  droppedJoinLanes,
  formatOrgJoinCommand,
  initOrg,
  joinOrg,
  joinRecordPath,
  joinsDir,
  loadOrg,
  openJoinLanes,
  orgFile,
  parseOrgAgentSpecs,
  parseOrgLaneSpecs,
  parseQueue,
  planOrg,
  readJoins,
  OrgError,
  OrgNotConfiguredError,
} from '../core/org/org.js';

const ORG_USAGE = `Usage: phm org [--json] [--text] [--minutes N]
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
                                Skips team planning when no org.toml is configured; the skip names the
                                probed file and how to get one.
  init --member <id> --machine <id> [--name <name>] [--lane <lane>[=<share>]]... [--agent <id>:<lane>]...
                                Write a starter org.toml (default ~/.ashlr/org.toml, or --file)
                                declaring <member> as leader (founder) of a new org on <machine>.
                                A bare --lane declares share 100; =<share> sets 0-100. Each --agent
                                declares an implementer agent on <machine> for that lane, reporting
                                to the founder; without one phm org plan can assign nothing. Refuses
                                to overwrite an existing file. Add members, agents and lanes by editing
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

/** --lane takes <lane> or <lane>=<share>; a comma separates lanes too, the same
 * list spelling --caps uses, so `--lane a,b` and `--lane a --lane b` opt in
 * identically. Lane ids and shares never contain a comma, so the split is
 * unambiguous; each item still parses (and refuses) on its own, so a stray
 * comma lands on the empty-name error rather than being silently dropped. */
function takeLanes(args: string[]): string[] {
  return take(args, '--lane').flatMap((s) => s.split(',').map((part) => part.trim()));
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
  // `file` is hoisted so the not-configured plan catch can name the org.toml
  // that was probed — including a --file override — the same path join and
  // show report when they refuse. It stays undefined until line one of the
  // try assigns it, and OrgNotConfiguredError can only come from loadOrg(file)
  // after that assignment, so the catch always sees the resolved path.
  let file: string | undefined;
  try {
    file = one(args, '--file') ?? orgFile();
    const [sub, ...rest] = args;
    if (sub !== 'show' && sub !== 'join' && sub !== 'plan' && sub !== 'init') {
      return orgUsage(json, 'org', typeof sub === 'string' && !sub.startsWith('-') ? `Unknown org command '${sub}'` : undefined);
    }
    command = sub;
    if (sub === 'init') {
      const member = one(rest, '--member'), machine = one(rest, '--machine'), name = one(rest, '--name');
      const laneArgs = takeLanes(rest);
      const agentArgs = take(rest, '--agent');
      noLeftovers(rest);
      if (!member || !machine) throw new OrgError('init needs --member and --machine.');
      // Same flag shape as join's --lane, except a bare lane declares the full share (100)
      // and the share itself is bounded by the schema's 0-100, not a prior declaration.
      const lanes = parseOrgLaneSpecs(laneArgs, { defaultShare: 100 });
      // --agent takes <id>:<lane>; the schema allows one lane per agent id, so a
      // repeated id is refused here with the same shape as a repeated --lane.
      const agents = parseOrgAgentSpecs(agentArgs);
      const r = initOrg({ member, machine, ...(name === undefined ? {} : { name }), lanes, agents }, file);
      const m = r.org.members[0]!;
      const laneText = m.contributions.length ? m.contributions.map((c) => `${c.lane} ${c.share}%`).join(', ') : 'none';
      const agentText = m.agents.length ? `, agents ${m.agents.map((a) => `${a.id} (${a.roles.join('/')} on ${a.lane})`).join(', ')}` : '';
      const joinHint = `${formatOrgJoinCommand(m.id, m.machines[0]!.id, m.contributions.map((c) => c.lane))} --json`;
      return print({ schema: 'org.init.v1', file: r.file, leader: r.org.leader, member: m.id, machine: m.machines[0]!.id, lanes: m.contributions, agents: m.agents },
        `Wrote ${r.file}: ${r.org.leader} leads ${m.name} on ${m.machines[0]!.id} with lanes ${laneText}${agentText}.\nEdit the file to add members, agents and lanes. Each machine opts in with:\n  ${joinHint}\nThe leader plans with: phm org plan --json`);
    }
    const queueFile = sub === 'plan' ? one(rest, '--queue') : undefined;
    if (sub === 'plan') noLeftovers(rest);
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
      const laneArgs = takeLanes(rest);
      noLeftovers(rest);
      if (!member || !machine) {
        // --machine asserts which of the member's declared computers this join
        // records, so it stays explicit — but the refusal can still hand back
        // the runnable command when org.toml leaves exactly one choice, and
        // name the declared machines or members when it does not.
        const row = member === undefined ? undefined : org.members.find((m) => m.id === member);
        if (machine === undefined && row?.machines.length === 1) {
          const fix = formatOrgJoinCommand(member!, row.machines[0]!.id, laneArgs);
          throw new OrgError(`join needs --machine: ${member} declares one machine — run: ${fix}`);
        }
        const missing = member === undefined && machine === undefined ? '--member and --machine'
          : member === undefined ? '--member' : '--machine';
        const detail = row === undefined
          ? (member === undefined ? '' : ` Unknown member ${member}. This org.toml declares: ${org.members.map((m) => m.id).join(', ')}.`)
          : row.machines.length === 0 ? ` ${member} declares no machines in org.toml; ask the leader to add one before join.`
          : ` ${member} declares machines: ${row.machines.map((x) => x.id).join(', ')} — pass --machine <id>.`;
        throw new OrgError(`join needs ${missing}.${detail}`);
      }
      // --lane takes <lane> or <lane>=<share>; a second '=', an empty name or a
      // non-numeric share is a usage error, and the same lane is never repeated.
      const optIn = parseOrgLaneSpecs(laneArgs);
      // Read the machine's current record before joinOrg replaces it, so a re-join that
      // stops naming a lane reports the opt-out instead of dropping it silently.
      const prior = readJoins().find((j) => j.member === member && j.machine === machine);
      const r = joinOrg(org, { member, machine, optIn });
      const recordFile = joinRecordPath(r.member, r.machine);
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
          `${formatOrgJoinCommand(r.member, r.machine, [...r.lanes, ...open.map((l) => l.lane)])}.\n`
        : '';
      return print({ schema: 'org.join.v1', record: r, dir: joinsDir(), recordFile, droppedLanes: dropped, availableLanes: open }, `${r.member} joined on ${r.machine} with ${r.lanes.length ? r.lanes.map((l) => `${l.lane} ${l.share}%`).join(', ') : 'no lanes (nothing contributed)'}.\n${droppedNote}${openNote}Record: ${recordFile}\nSign in to your own provider CLIs on this machine; nothing was sent and no auth was read. Copy the record file into the leader's joins directory to count this machine.`);
    }
    const queue = queueFile ? parseQueue(readFileSync(queueFile, 'utf8')) : [];
    let view = null;
    try { view = await (await import('../core/fabric/resource-view-store.js')).readResourceView(); } catch { /* unknown usage is planned conservatively */ }
    const [{ readFleetResourcePlan }, { runsRoot }] = await Promise.all([
      import('../core/usage/resource-live/fleet-plan.js'), import('../core/metrics/loop-collect.js'),
    ]);
    const now = new Date();
    const capacity = await readFleetResourcePlan(runsRoot(), now.getTime()).catch(() => null);
    const joins = readJoins();
    const plan = planOrg(org, joins, view, queue, now, capacity?.lanes);
    // Text mode names each held lane and the join that opts it in; the JSON plan
    // already carries the same held rows, so --json consumers lose nothing.
    // A re-join replaces the machine's whole record, so a fix naming only the
    // held lane would drop the opt-ins that record already carries. When this
    // machine holds an unambiguous record for the member — the single declared
    // machine's own, or the member's only record on a declared machine — the
    // fix keeps its opted-in lanes at their recorded shares and adds the held
    // lane, the same command join's own open-lane note prints. Lanes the member
    // no longer declares stay out: joinOrg would refuse them.
    const heldLines = plan.held.map((h) => {
      const member = org.members.find((m) => m.id === h.member);
      const machines = member?.machines.map((x) => x.id) ?? [];
      const declared = new Set(member?.contributions.map((c) => c.lane) ?? []);
      const memberRecords = joins.filter((j) => j.member === h.member && machines.includes(j.machine));
      const record = machines.length === 1 ? memberRecords.find((j) => j.machine === machines[0])
        : memberRecords.length === 1 ? memberRecords[0] : undefined;
      const machineArg = record?.machine ?? (machines.length === 1 ? machines[0]! : machines.length ? `<${machines.join('|')}>` : null);
      if (machineArg === null) return `  held ${h.member}/${h.lane}: ${h.reason} — add a machine for this member in org.toml before join`;
      const kept = (record?.lanes ?? []).filter((l) => l.lane !== h.lane && declared.has(l.lane));
      return `  held ${h.member}/${h.lane}: ${h.reason} — on that member's machine run: ${formatOrgJoinCommand(h.member, machineArg, [...kept, h.lane])}`;
    });
    // An empty queue makes the headline counts read like a broken org: with no
    // jobs to assign, "0 assigned, 0 unassigned" is the honest answer, not a
    // failure — but only if the output says there was nothing to plan. Name
    // the missing input and the snapshot shape so a first run knows to pass
    // --queue. Text only: --json consumers already see the empty
    // assignments/unassigned arrays and chose whether to pass --queue.
    const queueNote = queue.length === 0
      ? [`Queue empty (${queueFile === undefined ? 'no --queue file given' : `${queueFile} held no jobs`}): pass --queue <jobs.json> ([{"id","priority?","costPct?","lane"?}]) to plan real assignments — the counts above mean there was nothing to plan.`]
      : [];
    // The plan covers only the join records this machine holds; a member's
    // machine sees a partial org, so say which records counted.
    return print({ ...plan, joinsDir: joinsDir() }, [`Plan for ${plan.leader}: ${plan.assignments.length} assigned, ${plan.unassigned.length} unassigned, ${plan.held.length} lanes held`,
      ...queueNote,
      ...plan.assignments.map((a) => `  ${a.job} -> ${a.agent} (${a.member}/${a.lane}, ~${a.costPct}%)`),
      ...plan.unassigned.map((u) => `  ! ${u.job}: ${u.reason}`),
      ...heldLines,
      `Opt-in counts join records held on this machine (${joinsDir()}); the plan covers only those records.`].join('\n'));
  } catch (err) {
    if (command === 'plan' && err instanceof OrgNotConfiguredError) {
      // A first run on a machine with no org.toml must not dead-end: name the
      // probed file and print the same guidance join/show give — where a copy
      // comes from and how to start a new org — instead of a bare skip notice.
      return print({ schema: 'org.plan.v1', state: 'not-configured', generatedAt: null, leader: null,
        budgets: null, roles: null, assignments: null, unassigned: null, held: null, joinsDir: null,
        file: file ?? orgFile() },
      `Team org not configured; planning skipped. ${err.message}`);
    }
    return orgFailure(json, command, err);
  }
}
