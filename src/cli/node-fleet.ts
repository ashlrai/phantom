/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import { hostname } from 'node:os';
import type { DriveNodes, NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, joinHintCommand, knownOwnerScopes, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import { validId, type NodeAuth } from '../core/drive/nodes/state.js';
import type { SelfUpdatePlan } from '../core/drive/nodes/phm-version.js';
import type { LocalLaneProbeDeps } from '../core/drive/nodes/local-model-caps.js';
import { parseNodeWatchFlags, type NodeWatchFlags } from './node-watch.js';
import type { NodeBeatWatchDeps } from './node-beat-watch.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
  /** This build's version for the join `phm-<version>` cap and the status/list
   * drift target; defaults to localPhmVersion. */
  phmVersion?: () => string | null;
  /** This computer's hostname for the join `--node` default; defaults to os.hostname. */
  hostname?: () => string;
  /** Test seam for the standalone join's local-model lane probe
   * (`local-lanes.json` + live headroom → advertised caps); defaults to this
   * machine's real probe. */
  localLanes?: LocalLaneProbeDeps;
  /** Test seam for `join --watch`: forwarded to the beat watch loop (run, sleep,
   * signal, capacity/host-stats measurement). */
  watch?: NodeBeatWatchDeps;
  /** Test seam for the bare join's sign-in lane probe (provider CLIs plus the
   * gh login check, exit codes only); defaults to this machine's real probe.
   * An explicit --caps skips the probe entirely. */
  providerLanes?: () => string[];
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
    // The standalone keep-alive is `join --watch`: a bare join's session dies
    // 30 s after its last beat, so the hint that restores "Phantom running"
    // must also hold the session. This view only renders for the local store —
    // a pool Mac's status delegates before reaching here.
    hints.set(n.nodeId, joinHintCommand(n.nodeId, profile, { watch: true }));
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
      // The same unknown-scope guard the status empty-scope hint applies: a
      // mistyped --owner must not be invited to enqueue into a scope fragment
      // no node serves, so the note names the scopes the store does know —
      // but only when the requested scope is absent from them (a scope with a
      // node and no jobs is legitimate and keeps the plain enqueue line). With
      // no --owner at all, one known scope also replaces the <scope>
      // placeholder with a runnable command.
      const known = knownOwnerScopes(nodes) ?? [];
      const hint = known.length > 0 && (owner === undefined || !known.includes(owner))
        ? ` This store knows: ${known.join(', ')}.` : '';
      const target = owner ?? (known.length === 1 ? known[0]! : '<scope>');
      return `No jobs queued in ${scope}.${hint} Enqueue one: phm node enqueue --job <id> --owner ${target}`;
    }
    const counts = { pending: 0, running: 0, completed: 0 };
    for (const j of jobs) counts[j.state] += 1;
    return `No routable jobs. ${jobs.length} job(s) in ${scope}: ${counts.pending} pending, ${counts.running} running, ${counts.completed} completed.`;
  } catch { return 'No routable jobs.'; }
}

/** Lanes a bare standalone join advertises from this machine's own sign-ins:
 * the same exit-code-only provider probe a pool worker runs, plus `gh` when
 * the local gh login check passes. Sign-in state is read on this machine only —
 * no credential, token or auth file leaves it. */
async function joinSignInLanes(probeAuth: () => NodeAuth): Promise<string[]> {
  const { probeProviderBinaries } = await import('../core/drive/nodes/worker.js');
  return [...Object.keys(probeProviderBinaries()), ...(probeAuth() === 'ok' ? ['gh'] : [])].sort();
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
    const lines = [
      `Joined ${String(out['nodeId'])} as session ${String(out['session'])} for ${owners.length === 1 ? 'owner' : 'owners'} ${owners.join(', ')} (caps: ${caps.join(', ') || 'none'}).`,
      'The session expires 30 seconds after the last beat. Keep it live:',
      `  ${String(out['next'])}`,
      'This registry is local to this machine — the node sees only jobs enqueued on this computer; other machines cannot see it. A shared queue needs the SSH pool (docs/NODES.md; join commands: docs/AGENT-NETWORK.md).',
    ];
    // A malformed local-lanes.json is a diagnostic, not a join failure: the
    // node joined without its lane caps, and the reply names the broken file.
    const lanes = out['localLanes'] as { error?: unknown; fix?: unknown } | undefined;
    if (typeof lanes?.error === 'string') {
      const fix = typeof lanes.fix === 'string' ? lanes.fix : 'Run: phm node lanes';
      lines.push(`Local model lanes not advertised: ${lanes.error}. ${fix}`);
    }
    // A re-join replaces the whole advertised profile, so owners, caps or the
    // --slots bound the last join carried but this one did not are gone —
    // silently, unless the reply names them. `dropped` rides the reply only
    // when something was actually lost; `restore` is the re-join that keeps
    // this join's profile and adds the dropped pieces back.
    const dropped = out['dropped'] as { owners?: string[]; caps?: string[]; slots?: number; restore?: string } | undefined;
    if (dropped !== undefined) {
      const lost = [
        dropped.owners?.length ? `owner scopes ${dropped.owners.join(', ')}` : null,
        dropped.caps?.length ? `caps ${dropped.caps.join(', ')}` : null,
        dropped.slots !== undefined ? `the --slots ${dropped.slots} bound` : null,
      ].filter((part): part is string => part !== null);
      lines.push(`This join replaces the profile the node last advertised and drops ${lost.join('; ')}. Name them again to keep them:`,
        `  ${String(dropped.restore)}`);
    }
    // A bare join advertises whatever this machine's sign-ins support; name
    // the detected set so the caps line never reads as a choice the operator
    // made, and point at --caps for a different advertisement. An empty probe
    // is the first-run case that matters most: the node advertises no sign-in
    // lanes, so say that and name the way to give it some instead of letting
    // `caps: phm-<version>` read as a working advertisement.
    const auto = out['autoCaps'] as string[] | undefined;
    if (auto !== undefined) {
      lines.push(auto.length
        ? `Caps auto-detected from this machine's sign-ins: ${auto.join(', ')}. Pass --caps to advertise a different set.`
        : 'No codex, claude or gh sign-ins detected on this machine — the join advertises no sign-in lanes. Sign in to one and join again, or pass --caps to advertise lanes yourself.');
    }
    return lines.join('\n');
  }
  if (verb === 'beat') {
    // Beat is the keep-alive `join --watch` and `beat --watch` print every pass,
    // so its text answer is one sentence like the other verbs', not the
    // key:value dump. auth appears only when the beat carried --probe-auth or
    // --auth; 'ok' is the only report that lets gh work route to the node.
    const auth = typeof out['auth'] === 'string' ? `; auth ${out['auth']}` : '';
    return `Heartbeat recorded for ${String(out['nodeId'])}${out['leader'] === true ? ' (leader)' : ''}${auth}.`;
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
      lines.push(`Join this computer: phm node join --owner ${scope} --watch`);
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
    if (state === 'running') return `job ${jobId}: ${jobStateWords({ state, claimedBy: out['claimedBy'] as string | undefined })}`;
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
  // Operator-facing label for the standalone store, resolved once the store
  // modules load; the catch's fix text names the real $ASHLR_HOME/nodes
  // (home-contracted) instead of assuming the default ~/.ashlr spelling.
  let nodesDirLabel = '~/.ashlr/nodes';
  try {
    // `join --watch` is a dispatcher-level keep-alive like `beat --watch`: the
    // watch flags are stripped here so the fleet parser never sees them, and a
    // successful standalone join hands its new session to the beat watch loop.
    let joinWatch: NodeWatchFlags | null = null;
    if (verb === 'join' && args.includes('--watch')) {
      const parsed = parseNodeWatchFlags(args);
      if ('error' in parsed) throw new UsageError('usage', parsed.error, 'Run: phm node join --help');
      joinWatch = parsed;
      args = parsed.base;
    }
    const flags = parseNodeFleetFlags(verb, args);
    if (!deps.store) {
      const { cmdNodePool, hasNodePool } = await import('./node-pool.js');
      if (hasNodePool()) {
        // A pool join releases its probe session on purpose and workers hold
        // their own sessions per batch, so the standalone keep-alive has no
        // pool meaning — refuse rather than silently drop --watch.
        if (joinWatch !== null) throw new UsageError('usage',
          'join --watch keeps a standalone registry session alive; this Mac is in a node pool, where join releases its probe session and workers hold their own sessions per batch.',
          'Run: phm node join --json, then phm node worker --runner /absolute/host-owned-runner --json');
        return cmdNodePool(verb, args);
      }
    }
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome, ashlrHomePath }, { canonicalPath, privateDirectory }, { join },
      { localPhmVersion, versionCap, versionFromCaps, planNodeSelfUpdate }, { probeLocalLanePlan }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path'),
      import('../core/drive/nodes/phm-version.js'), import('../core/drive/nodes/local-model-caps.js')]);
    nodesDirLabel = ashlrHomePath('nodes');
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) };
    const drive = new DriveNodes(store, deps.now ? { now: deps.now } : {});
    // Join's lane probe runs once; a malformed local-lanes.json rides the reply
    // as a diagnostic below instead of silently costing the node its lane caps.
    let localLaneError: string | null = null;
    // The sign-in lanes a bare join advertised, named in the reply so the caps
    // list never reads as a choice the operator made.
    let autoCaps: string[] | undefined;
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
      // A bare join (no --caps) advertises the lanes this machine's own
      // sign-ins support — the same exit-code-only probe a pool worker runs —
      // so a first node does not have to know the cap names: sign in to codex,
      // claude or gh here and the join advertises that lane. An explicit
      // --caps stays the complete manual advertisement and skips the probe.
      if (!flags.has('--caps')) {
        const lanes = [...new Set(deps.providerLanes?.() ?? await joinSignInLanes(deps.probeAuth ?? probeLocalAuth))].sort();
        // The probe outcome rides the reply even when empty: autoCaps: [] says
        // "probed, found no sign-ins" where an absent key means the operator
        // passed --caps and no probe ran — the same distinction the pool
        // worker's 'no-local-provider-login' hold makes for a lane-less join.
        autoCaps = lanes;
        if (lanes.length > 0) flags.set('--caps', lanes.join(','));
      } else {
        // An explicit --caps that names nothing is a scripting accident
        // (`--caps "$EMPTY"`), not a deliberate empty advertisement: silently
        // joining with zero work caps where a bare join would have
        // auto-detected this machine's sign-ins leaves a first-run node that
        // looks joined but can never take a lane job. The pool wire still
        // accepts an empty --caps (a lane-less worker legitimately joins with
        // none), so this refusal stays on the standalone CLI path only.
        const named = (flags.get('--caps') ?? '').split(',').map(c => c.trim()).filter(Boolean);
        if (named.length === 0) {
          throw new UsageError('bad-caps', '--caps needs at least one capability.',
            'Omit --caps to auto-detect this machine\'s sign-ins, or name capabilities such as build,gh. Run: phm node --help');
        }
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
      // A standalone join also advertises this machine's planned local-model
      // lanes — the same caps a pool join or worker sends through
      // probeNodeLanes — so a node with local-lanes.json enabled is not
      // invisible to --requires omlx jobs. Like the version cap this stays in
      // the CLI layer: runNodeFleet is shared with the SSH endpoint, where the
      // joining worker's own machine — not this host — owns the lanes it
      // reports. An absent, disabled or backed-off lane contributes nothing;
      // explicit --caps entries are kept and deduped against the probe. A
      // malformed local-lanes.json contributes nothing either, but its parse
      // error is kept for the reply: silently dropping a lane the operator
      // asked for is exactly the failure `phm node lanes` exists to explain.
      const laneProbe = probeLocalLanePlan(deps.localLanes);
      localLaneError = laneProbe?.configError ?? null;
      const localCaps = laneProbe?.plan.caps ?? [];
      if (localCaps.length > 0) {
        const caps = [...new Set([...(flags.get('--caps') ?? '').split(',').map(c => c.trim()).filter(Boolean), ...localCaps])];
        flags.set('--caps', caps.join(','));
      }
    }
    // rejoinWatch: this path only runs with no pool config (or an injected
    // store), so a session-expired fix may name `join --watch` — the command
    // that both creates the session and holds it live.
    const out = runNodeFleet(verb, flags, drive, deps.probeAuth ?? probeLocalAuth, { rejoinWatch: true });
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
      if (autoCaps !== undefined) out['autoCaps'] = autoCaps;
      // The node joined without its lane caps; name the broken file so the
      // first-run output says why instead of looking never-configured.
      if (localLaneError !== null) {
        out['localLanes'] = { state: 'invalid', error: localLaneError, fix: 'Run: phm node lanes' };
      }
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
    if (joinWatch !== null) {
      // The join printed its session; now hold it live exactly like
      // `phm node beat --watch` — same loop, same fresh capacity/host-stats
      // samples, and --probe-auth under the same gh-cap rule `next` uses.
      const { cmdNodeBeatWatch } = await import('./node-beat-watch.js');
      const caps = out['caps'];
      const probe = Array.isArray(caps) && caps.includes('gh') ? ['--probe-auth'] : [];
      const { watch: watchDeps, ...fleetDeps } = deps;
      const run = watchDeps?.run ?? (async (beatArgs: string[]) => cmdNodeFleet('beat', beatArgs, fleetDeps));
      return cmdNodeBeatWatch([
        '--node', String(out['nodeId']), '--session', String(out['session']),
        ...(json ? ['--json'] : []), ...probe, '--every', String(joinWatch.everySeconds),
      ], { ...watchDeps, run });
    }
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    // Validation, privacy and lock messages in this stack are fixed operator-facing
    // strings (no values echoed), so they are shown; anything else stays masked.
    const operatorMessage = /^(?:Invalid |Drive |(?:Universe|Private) storage|Unsafe drive|Cannot create filesystem root)/;
    const message = error instanceof Error && (known || operatorMessage.test(error.message)) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : `Check that ${nodesDirLabel} is a private (0700) directory you own, and that no other process holds its lock.`;
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: verb, error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}
