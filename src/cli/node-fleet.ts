/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import { hostname } from 'node:os';
import type { DriveNodes, NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, joinHintCommand, knownOwnerScopes, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import { validId, type NodeAuth } from '../core/drive/nodes/state.js';
import type { SelfUpdatePlan } from '../core/drive/nodes/phm-version.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
  /** This build's version for the join `phm-<version>` cap and the status/list
   * drift target; defaults to localPhmVersion. */
  phmVersion?: () => string | null;
  /** This computer's hostname for the join `--node` default; defaults to os.hostname. */
  hostname?: () => string;
}


/** Plain-words job state for the status list. `claimedBy` is present only while
 * a live session can still act on the claim, so a running job without it has a
 * lapsed or fenced claim and is routable again once the claim expires. */
function jobStateWords(job: { state: string; claimedBy?: string; completedBy?: string; producerWithdrawn?: true }): string {
  if (job.state === 'running') return job.claimedBy ? `running (claimed by ${job.claimedBy})` : 'running (no live claim)';
  if (job.state === 'completed') {
    if (job.producerWithdrawn) return 'completed (withdrawn by the producer)';
    return job.completedBy ? `completed by ${job.completedBy}` : 'completed';
  }
  return job.state;
}

/** Plain words for the capacity holds a beat --capacity sample can report (isNodeCapacity). */
const PULL_HELD_WORDS: Record<string, string> = {
  'memory-unmeasured': 'memory not measured',
  'memory-pressure': 'memory pressure',
  'disk-unmeasured': 'disk not measured',
  'disk-pressure': 'disk pressure',
};

/** Rejoin command per expired node in a status view, keyed by node id. The
 * profile comes from `nodeProfile` — the full advertised owners, caps and
 * slots, not the scope-filtered view fields — so the hint restores exactly
 * what the node last advertised and never silently drops a scope it joined
 * with. A profile read that fails degrades to the generic rejoin hint rather
 * than failing the status report. */
function expiredRejoinHints(nodes: DriveNodes, out: Record<string, unknown>): Map<string, string> | undefined {
  const view = out['nodes'];
  if (!Array.isArray(view)) return undefined;
  const hints = new Map<string, string>();
  for (const n of view as { nodeId?: unknown; live?: unknown }[]) {
    if (n.live !== false || typeof n.nodeId !== 'string') continue;
    let profile: ReturnType<DriveNodes['nodeProfile']> = null;
    try { profile = nodes.nodeProfile(n.nodeId); } catch { /* degrade to the generic rejoin hint */ }
    hints.set(n.nodeId, joinHintCommand(n.nodeId, profile));
  }
  return hints.size ? hints : undefined;
}

/** Text-only note for an empty `phm node plan`: an empty routes array cannot
 * say whether the scope holds no jobs or jobs that are all claimed or
 * complete, so the note counts them from one snapshot — the same read the
 * status empty-scope hint makes. Scope matching mirrors planRoutes exactly:
 * ownerless legacy jobs never route and are not counted, and plan's --owner
 * is a single scope. The counts are point-in-time facts: a job enqueued
 * between the plan and this read still reports honestly. */
function planEmptyNote(nodes: DriveNodes, owner: string | undefined): string {
  try {
    const jobs = nodes.snapshot().jobs.filter(j => j.owner && (owner === undefined || j.owner === owner));
    const scope = owner === undefined ? 'any owner scope' : `owner '${owner}'`;
    if (!jobs.length) {
      return `No jobs queued in ${scope}. Enqueue one: phm node enqueue --job <id> --owner ${owner ?? '<scope>'}`;
    }
    const counts = { pending: 0, running: 0, completed: 0 };
    for (const j of jobs) counts[j.state] += 1;
    return `No routable jobs. ${jobs.length} job(s) in ${scope}: ${counts.pending} pending, ${counts.running} running, ${counts.completed} completed.`;
  } catch { return 'No routable jobs.'; }
}

function text(verb: string, out: Record<string, unknown>, notes?: {
  rejoin?: ReadonlyMap<string, string>;
  drift?: SelfUpdatePlan;
  knownScopes?: readonly string[];
  planEmpty?: string;
}): string {
  if (verb === 'join') {
    // Join is the first command every new node runs; its text answer is a
    // sentence, not the key:value dump, and it states the 30-second session
    // expiry the keep-alive exists to beat (docs/add-a-computer.md). The
    // last line names the standalone registry's boundary: this store is
    // private to this machine, so the node only ever sees jobs enqueued here.
    const owners = out['owners'] as string[];
    const caps = out['caps'] as string[];
    return [
      `Joined ${String(out['nodeId'])} as session ${String(out['session'])} for ${owners.length === 1 ? 'owner' : 'owners'} ${owners.join(', ')} (caps: ${caps.join(', ') || 'none'}).`,
      'The session expires 30 seconds after the last beat. Keep it live:',
      `  ${String(out['next'])}`,
      'This registry is local to this machine — the node sees only jobs enqueued on this computer; other machines cannot see it. A shared queue needs the SSH pool (docs/NODES.md; join commands: docs/AGENT-NETWORK.md).',
    ].join('\n');
  }
  if (verb === 'plan') {
    const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[];
    return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : notes?.planEmpty ?? 'No routable jobs.';
  }
  if (verb === 'status' || verb === 'list') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number | null; auth: string; caps: string[];
      slots?: number; capacity?: { held?: string | null } }[];
    const jobs = out['jobs'] as { id: string; state: string; claimedBy?: string; completedBy?: string; producerWithdrawn?: true }[];
    const scope = (out['owners'] as string[]).join(',');
    // A job still waiting on a taker carries the same fix `phm node plan`
    // prints, so status answers "why is this pending" without a second
    // command. view() already returns the routes; --json consumers had them,
    // text mode simply never rendered them. Only unrouted jobs are annotated:
    // a routed pending job keeps its bare state — its node will pull it.
    const fixes = new Map((out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[] | undefined ?? [])
      .filter(r => r.nodeId === null && typeof r.fix === 'string')
      .map(r => [r.jobId, r.fix!]));
    // slots is the advertised admission bound: a reported number (0 holds
    // admission), or 'unbounded' when none was reported — an absent bound is
    // legacy unbounded routing, not a measured zero. held is the last measured
    // capacity hold, shown only while one is reported. An expired node names
    // the rejoin command that restores its last advertised profile — the same
    // hint a session-expired error prints — so the diagnostic command also
    // says how to bring the node back.
    const rejoinFor = (nodeId: string): string => {
      const cmd = notes?.rejoin?.get(nodeId);
      return cmd === undefined ? '' : ` — rejoin: ${cmd}`;
    };
    // A node that outlived a phm upgrade keeps advertising its join-time build —
    // beats renew the session but never re-stamp caps — so status reads the same
    // drift verdict `phm node self-update` plans instead of leaving the stale
    // `phm-<version>` cap for the operator to interpret. Only non-current
    // states annotate; the version itself already sits in caps.
    const driftFor = (nodeId: string): string => {
      const row = notes?.drift?.nodes.find(n => n.nodeId === nodeId);
      return row !== undefined && row.status !== 'current' ? ` phm=${row.status}` : '';
    };
    const lines = [`Owner scope: ${scope}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage ?? 'unknown'} auth=${n.auth} slots=${n.slots ?? 'unbounded'}${n.capacity?.held ? ` held=${n.capacity.held}` : ''} caps=${n.caps.join(',') || '-'}${driftFor(n.nodeId)}${n.live ? '' : rejoinFor(n.nodeId)}`),
      ...jobs.map(j => `job ${j.id} ${jobStateWords(j)}${fixes.has(j.id) ? ` — ${fixes.get(j.id)}` : ''}`)];
    // An empty scope is the first-run case: say so and print the join command,
    // the same next step `phm node plan` prints for a job with no live node.
    // view() filters to the requested scopes, so an empty view also means none
    // of them exist in this store — naming the scopes it does know turns a
    // mistyped --owner into a correction instead of a second scope fragment.
    if (!nodes.length) lines.push('No nodes joined in this scope.');
    if (!jobs.length) lines.push('No jobs queued in this scope.');
    if (!nodes.length && !jobs.length && scope) {
      const known = notes?.knownScopes;
      if (known !== undefined && known.length > 0) {
        lines.push(`This store knows: ${known.join(', ')} — none of the requested scopes have nodes or jobs here.`);
      }
      lines.push(`Join this computer: phm node join --owner ${scope}`);
    }
    // self-update takes one --owner scope; a multi-scope status keeps the
    // placeholder rather than silently checking only the first scope.
    const driftPlan = notes?.drift;
    if (driftPlan !== undefined && driftPlan.drifted.length) {
      const owner = scope.includes(',') ? '<scope>' : scope;
      lines.push(`Some nodes run a different phm build than this machine or do not report one: phm node self-update --owner ${owner} reports the per-node update plan.`);
    }
    return lines.join('\n');
  }
  if (verb === 'enqueue') {
    // enqueued:false means the job id is already taken — enqueue is idempotent
    // on the id, so this is a fact, not a failure.
    const jobId = String(out['jobId']);
    return out['enqueued'] === true ? `Enqueued ${jobId}.` : `Job ${jobId} already exists; nothing changed.`;
  }
  if (verb === 'withdraw') {
    const jobId = String(out['jobId']);
    switch (out['state']) {
      case 'withdrawn': return `Job ${jobId} withdrawn: it is terminal and can never run again.`;
      case 'held': return `Job ${jobId} is held by a live claim; withdraw again once the claim lapses or completes.`;
      case 'completed': return `Job ${jobId} already completed.`;
      default: return `Job ${jobId} is absent in this owner scope (unknown id or another owner's job).`;
    }
  }
  if (verb === 'renew') {
    const expires = typeof out['expiresAt'] === 'number' ? new Date(out['expiresAt']).toISOString() : 'unknown';
    return `Renewed ${String(out['jobId'])}; the lease expires ${expires}.`;
  }
  if (verb === 'complete') return `Completed ${String(out['jobId'])}.`;
  if (verb === 'release') {
    // The claim is already fenced dead by the time this prints; declined means
    // this session is barred from the job, not that the job is gone.
    const jobId = String(out['jobId']);
    return out['declined'] === true
      ? `Released ${jobId}; it is pending again and this session will not be offered it.`
      : `Released ${jobId}; it is pending again.`;
  }
  if (verb === 'leave') {
    const nodeId = String(out['nodeId']);
    if (out['left'] === true) return `Node ${nodeId} left the registry.`;
    return typeof out['liveSession'] === 'number'
      ? `Node ${nodeId} was not left; it is live as session ${out['liveSession']}. Run: ${String(out['next'])}`
      : `Node ${nodeId} was not left; no live session matches that node and session.`;
  }
  if (verb === 'pull') {
    if (!out['pulled']) {
      // An empty pull can still say why this node takes nothing: a measured
      // capacity hold or an advertised zero-slot bound (the same words
      // `phm node status` uses), or open work that fit but routed elsewhere.
      // Any of them means the queue was not simply empty.
      const held = typeof out['held'] === 'string' ? out['held'] : null;
      const slots = typeof out['slots'] === 'number' ? out['slots'] : null;
      const open = typeof out['open'] === 'number' && out['open'] > 0 ? out['open'] : null;
      const why = held !== null ? `this node is held (${PULL_HELD_WORDS[held] ?? held})`
        : slots === 0 ? 'this node advertises zero job slots'
        : open !== null ? `${open} open job${open === 1 ? '' : 's'} fit this node but routed to other nodes or wait on a free slot`
        : null;
      return why === null ? 'No job for this node. Run: phm node plan'
        : `No job for this node; ${why}. Run: phm node plan`;
    }
    // Text mode must carry everything a manual runner needs to work the lease:
    // the claim's fencing tokens (renew/complete refuse without them), the job's
    // requirements and secret NAMES, the embedded task text, and paste-ready
    // commands — the --json envelope is not the only way through the lifecycle.
    const claim = out['claim'] as { jobId: string; nodeId: string; session: number; token: number; leaderToken: number; expiresAt: number };
    const job = out['job'] as { owner?: string; requires?: string[]; pack?: string; secrets?: string[]; task?: { text?: unknown } } | undefined;
    const facts = [
      job?.owner === undefined ? null : `owner ${job.owner}`,
      job?.requires?.length ? `requires ${job.requires.join(',')}` : null,
      job?.pack === undefined ? null : `pack ${job.pack}`,
      job?.secrets?.length ? `secrets ${job.secrets.join(',')}` : null,
    ].filter((fact): fact is string => fact !== null);
    const lease = `--job ${claim.jobId} --node ${claim.nodeId} --session ${claim.session} --token ${claim.token} --leader-token ${claim.leaderToken}`;
    const lines = [
      `Claimed ${claim.jobId}${facts.length ? ` (${facts.join('; ')})` : ''}.`,
      `Lease token ${claim.token}, leader-token ${claim.leaderToken}; expires ${new Date(claim.expiresAt).toISOString()}. Renew before expiry; pass the token to every effect.`,
    ];
    if (typeof job?.task?.text === 'string' && job.task.text.length) lines.push('', 'Task:', job.task.text);
    // The third lifecycle verb matters as much as renew/complete here: a manual
    // runner that cannot do the job (missing secret, wrong pack, out of its
    // depth) must hand the claim back at once instead of stranding it until the
    // lease lapses. --decline stays optional — only a permanent inability bars
    // this session; a temporary one releases plainly and stays retryable.
    lines.push('', `Run: phm node renew ${lease}`, `Done? Run: phm node complete ${lease} --result <text>`,
      `Cannot run it? Run: phm node release ${lease} (add --decline if this node can never run it)`);
    return lines.join('\n');
  }
  if (verb === 'result') {
    const jobId = String(out['jobId']), state = out['state'];
    if (state === 'absent') return `job ${jobId}: absent (no such job in this owner scope)`;
    if (state === 'pending') return `job ${jobId}: pending`;
    if (state === 'running') return `job ${jobId}: running${out['claimedBy'] ? ` (claimed by ${out['claimedBy']})` : ''}`;
    const head = out['producerWithdrawn'] === true ? 'withdrawn by the producer'
      : `completed by ${String(out['completedBy'] ?? 'unknown')}`;
    const when = typeof out['completedAt'] === 'number' ? ` at ${new Date(out['completedAt']).toISOString()}` : '';
    const body = typeof out['result'] === 'string' && out['result'].length ? `\n${out['result']}` : '';
    return `job ${jobId}: ${head}${when}${body}`;
  }
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`).join('\n');
}

export async function cmdNodeFleet(verb: string, args: string[], deps: NodeFleetDeps = {}): Promise<number> {
  // `--json` is a boolean flag and a standalone `--json` token can never be a
  // flag value (values starting with `--` are refused), so argv alone proves
  // the caller asked for JSON even when flag parsing fails first.
  const json = args.includes('--json');
  try {
    const flags = parseNodeFleetFlags(verb, args);
    if (!deps.store) {
      const { cmdNodePool, hasNodePool } = await import('./node-pool.js');
      if (hasNodePool()) return cmdNodePool(verb, args);
    }
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { canonicalPath, privateDirectory }, { join }, { localPhmVersion, versionCap, versionFromCaps, planNodeSelfUpdate }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path'),
      import('../core/drive/nodes/phm-version.js')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) };
    const drive = new DriveNodes(store, deps.now ? { now: deps.now } : {});
    if (verb === 'join') {
      // A standalone join defaults --node to this computer's sanitized hostname,
      // the same default a pool join applies. Like the version cap below it stays
      // in the CLI layer: runNodeFleet is shared with the SSH endpoint, where the
      // joining worker — not this host — owns the node id it reports. A hostname
      // that cannot form a valid id leaves --node unset so the missing-flag error
      // still asks for one explicitly.
      if (!flags.has('--node')) {
        const id = (deps.hostname ?? hostname)().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
        if (validId(id)) flags.set('--node', id);
      }
      // A standalone join advertises this build as a `phm-<version>` cap, the same
      // report a pool worker sends, so `phm node self-update` reads a real version
      // instead of `unreported`. The node's own build is authoritative: any
      // version-report cap already in --caps (say, copied from an older join hint)
      // is dropped and replaced, never left to report a stale build. This stays in
      // the CLI layer: runNodeFleet is shared with the SSH endpoint, where the
      // joining worker — not this host — owns the version it reports.
      const reported = versionCap((deps.phmVersion ?? localPhmVersion)());
      if (reported !== null) {
        const caps = (flags.get('--caps') ?? '').split(',').map(c => c.trim()).filter(Boolean)
          .filter(c => versionFromCaps([c]) === null);
        caps.push(reported);
        flags.set('--caps', caps.join(','));
      }
    }
    const out = runNodeFleet(verb, flags, drive, deps.probeAuth ?? probeLocalAuth);
    // Standalone join names its keep-alive beat. This stays out of runNodeFleet:
    // pool replies already carry their own `next` (the worker command) and a
    // `next` inside result.result would override it in the spread below. The
    // hint is the --watch loop, the only beat form that keeps the session
    // live past the 30 s expiry; a node that advertised `gh` also gets
    // --probe-auth, because routing refuses gh jobs until a heartbeat reports
    // a working local gh login.
    if (verb === 'join') {
      const caps = out['caps'];
      const probe = Array.isArray(caps) && caps.includes('gh') ? ' --probe-auth' : '';
      out['next'] = `phm node beat --node ${String(out['nodeId'])} --session ${String(out['session'])}${probe} --watch`;
      // This path only runs with no pool config (cmdNodePool owns pooled
      // joins), so the store is this machine's private ~/.ashlr/nodes: name
      // that boundary in the reply instead of letting a first-time node
      // assume it joined a shared fleet.
      out['registry'] = 'local';
    }
    // status/list name each expired node's rejoin command. Text only: the
    // --json view stays the scope-filtered projection, and a machine caller
    // already gets the same command in a session-expired error's fix. The
    // profile reads run only for the rendered verbs, never for --json.
    const rejoin = !json && (verb === 'status' || verb === 'list') ? expiredRejoinHints(drive, out) : undefined;
    // status/list read phm-build drift against this machine through the same
    // pure plan self-update prints, so the two commands can never disagree.
    // Text only like rejoin: --json consumers already get caps per node.
    const drift = !json && (verb === 'status' || verb === 'list')
      ? planNodeSelfUpdate(out['nodes'] as Parameters<typeof planNodeSelfUpdate>[0], (deps.phmVersion ?? localPhmVersion)())
      : undefined;
    // status/list on a scope the store does not know still print the join
    // command; naming the scopes the store does know (minus the requested
    // ones, which an empty view proves are absent) lets the operator correct
    // a mistyped --owner before fragmenting the registry. Text only, like
    // rejoin/drift: the --json view stays the scope-filtered projection.
    const knownScopes = !json && (verb === 'status' || verb === 'list') &&
      Array.isArray(out['nodes']) && Array.isArray(out['jobs']) &&
      (out['nodes'] as unknown[]).length === 0 && (out['jobs'] as unknown[]).length === 0
      ? (knownOwnerScopes(drive) ?? []).filter(s => !(out['owners'] as string[]).includes(s))
      : undefined;
    // plan on an empty route set cannot tell an empty queue from jobs that
    // are all claimed or complete; the text-only note counts the scope's
    // jobs from one snapshot, like the status empty-scope hint. --json keeps
    // {routes} alone.
    const planEmpty = !json && verb === 'plan' && Array.isArray(out['routes']) && (out['routes'] as unknown[]).length === 0
      ? planEmptyNote(drive, flags.get('--owner'))
      : undefined;
    console.log(json ? JSON.stringify({ schemaVersion: 1, command: verb, ...out }) : text(verb, out, { rejoin, drift, knownScopes, planEmpty }));
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    // Validation, privacy and lock messages in this stack are fixed operator-facing
    // strings (no values echoed), so they are shown; anything else stays masked.
    const operatorMessage = /^(?:Invalid |Drive |Universe storage|Unsafe drive|Cannot create filesystem root)/;
    const message = error instanceof Error && (known || operatorMessage.test(error.message)) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : 'Check that ~/.ashlr/nodes is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: verb, error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}
