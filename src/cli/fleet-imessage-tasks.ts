/** Scoped teammate tasks: argument parsing only; send policy stays in core. */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { scrubSecrets } from '../core/util/scrub.js';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { cancelTeammateTask, enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskLedgerMatch, teammateTaskPeers,
  TEAMMATE_TASK_KINDS, TEAMMATE_TASK_PEERS, TEAMMATE_TASK_STATES,
  type TeammateTaskKind, type TeammateTaskLedgerFilter, type TeammateTaskPeer, type TeammateTaskState } from '../core/comms/imessage-teammate-tasks.js';

const USAGE = `Usage: phm fleet imessage-tasks enqueue --peer dot|instinct --job <id>
  --kind research|triage|report|rebase --scope <text> --repo <owner/name>
  [--pr <number> ...] --format <text> --deadline <ISO timestamp>
  [--apply|--dry-run] [--json]
       phm fleet imessage-tasks cancel --job <id> [--apply|--dry-run] [--json]
       phm fleet imessage-tasks dispatch [--apply|--dry-run] [--json]
       phm fleet imessage-tasks list [--job <id>] [--peer dot|instinct]
         [--state queued|sending|pending|replied|expired|cancelled]
         [--kind research|triage|report|rebase] [--json]
       phm fleet imessage-tasks peers [--json]
Enqueue, cancel and dispatch preview by default. Apply reserves work or uses the
existing approved teammate transport. Reports omit message bodies and handles.`;

// Reject malformed envelopes before configuration or ledger access.
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value) && scrubSecrets(value) === value);
const envelope = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).refine(value => scrubSecrets(value) === value),
  scope: text(1200), format: text(300),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/).max(200)
    .refine(value => scrubSecrets(value) === value),
  deadline: z.string().datetime({ offset: true }),
  prRefs: z.array(z.number().int().positive().safe()).max(20).optional(),
});

// CLI receipts are an explicit contract, independent of the private ledger view.
// Strip unknown keys at every level, including inside receipts and results.
const taskReceipt = z.object({
  jobId: z.string(), peer: z.string(), resource: z.string(), state: z.string(),
  claimKey: z.string(), kind: z.string().optional(), repo: z.string().optional(),
  prRefs: z.array(z.number().int()).optional(), createdAt: z.number(),
  attemptedAt: z.number().optional(), deadline: z.string(),
  receipt: z.object({
    rowid: z.number(), sent: z.boolean(), delivered: z.boolean(), error: z.number(),
  }).nullish(),
  result: z.object({
    rowid: z.number(), status: z.string(), at: z.number(), evidence: z.string(),
  }).nullish(),
});
const taskReport = z.object({
  schema: z.string().optional(), state: z.string().optional(), ok: z.boolean().optional(),
  dryRun: z.boolean().optional(), approved: z.boolean().optional(),
  error: z.string().optional(), reason: z.string().optional(),
  sent: z.number().optional(), replied: z.number().optional(), pending: z.number().optional(),
  task: taskReceipt.optional(), tasks: z.array(taskReceipt).optional(),
});

export interface FleetImessageTasksDeps {
  enqueue?: typeof enqueueTeammateTask;
  cancel?: typeof cancelTeammateTask;
  list?: typeof listTeammateTasks;
  dispatch?: typeof runTeammateTasks;
  peers?: typeof teammateTaskPeers;
  config?: typeof loadConfigReadOnlyStrict;
  output?: (text: string) => void;
  /** Observation clock. Deadline checks use this instead of the wall clock. */
  now?: () => number;
}

export async function cmdFleetImessageTasks(args: string[], deps: FleetImessageTasksDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const json = args.includes('--json');
  let parsed = false;
  try {
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, strict: true, tokens: true, options: {
      json: { type: 'boolean' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      peer: { type: 'string' }, job: { type: 'string' }, kind: { type: 'string' }, state: { type: 'string' },
      scope: { type: 'string' }, repo: { type: 'string' }, format: { type: 'string' },
      deadline: { type: 'string' }, pr: { type: 'string', multiple: true },
    } });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      if (token.name !== 'pr' && seen.has(token.name)) throw new Error('Duplicate option');
      seen.add(token.name);
    }
    if (values.help) { output(json ? JSON.stringify({ usage: USAGE }) : USAGE); return 0; }
    const [command] = positionals;
    if (positionals.length !== 1 || !['enqueue', 'cancel', 'dispatch', 'list', 'peers'].includes(command)) throw new Error('Invalid command');
    const allowed = command === 'enqueue'
      ? ['json', 'apply', 'dry-run', 'peer', 'job', 'kind', 'scope', 'repo', 'format', 'deadline', 'pr']
      : command === 'cancel' ? ['json', 'apply', 'dry-run', 'job'] : command === 'dispatch' ? ['json', 'apply', 'dry-run']
        : command === 'list' ? ['json', 'job', 'peer', 'state', 'kind'] : ['json'];
    if (Object.keys(values).some(key => !allowed.includes(key)) || values.apply && values['dry-run']) throw new Error('Invalid options');
    if (command === 'list') {
      if (values.job !== undefined && !envelope.shape.jobId.safeParse(values.job).success) throw new Error('Invalid job');
      if (values.peer !== undefined && !(TEAMMATE_TASK_PEERS as readonly string[]).includes(values.peer)) throw new Error('Invalid peer');
      if (values.state !== undefined && !(TEAMMATE_TASK_STATES as readonly string[]).includes(values.state)) throw new Error('Invalid state');
      if (values.kind !== undefined && !(TEAMMATE_TASK_KINDS as readonly string[]).includes(values.kind)) throw new Error('Invalid kind');
    }
    let result: object;
    if (command === 'enqueue') {
      const { peer, kind, job: jobId, scope, repo, format, deadline } = values;
      if ((peer !== 'dot' && peer !== 'instinct') ||
          (kind !== 'research' && kind !== 'triage' && kind !== 'report' && kind !== 'rebase') ||
          !jobId?.trim() || !scope?.trim() || !repo?.trim() || !format?.trim() || !deadline?.trim()) throw new Error('Missing task fields');
      const prRefs = values.pr?.map(value => {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid PR');
        return Number(value);
      });
      if (prRefs && new Set(prRefs).size !== prRefs.length) throw new Error('Duplicate PR');
      const nowMs = deps.now?.() ?? Date.now();
      const parsedEnvelope = envelope.safeParse({ jobId, scope, repo, format, deadline, prRefs });
      if (!parsedEnvelope.success || !Number.isFinite(nowMs) || Date.parse(deadline) <= nowMs) throw new Error('Invalid envelope');
      parsed = true;
      result = await (deps.enqueue ?? enqueueTeammateTask)({ jobId, peer, kind, scope, repo, format, deadline, ...(prRefs ? { prRefs } : {}) },
        (deps.config ?? loadConfigReadOnlyStrict)(), { apply: values.apply === true });
    } else if (command === 'cancel') {
      if (!envelope.shape.jobId.safeParse(values.job).success) throw new Error('Invalid job');
      parsed = true;
      result = await (deps.cancel ?? cancelTeammateTask)(values.job!, { apply: values.apply === true });
    } else {
      parsed = true;
      result = command === 'list' ? await (deps.list ?? listTeammateTasks)()
        : command === 'peers' ? await (deps.peers ?? teammateTaskPeers)()
        : await (deps.dispatch ?? runTeammateTasks)((deps.config ?? loadConfigReadOnlyStrict)(), { apply: values.apply === true });
    }
    // Peers retain their distinct owner declarations and peer-reported observations.
    let visible = command === 'peers' ? result : {
      ...taskReport.parse(result),
      coverage: 'local-evidence-only-peer-reported-results-unverified',
      claimKeyEvidence: 'label-only-queue-binding-unverified',
    };
    if (command === 'list') {
      const filter: TeammateTaskLedgerFilter = {
        ...(values.job !== undefined ? { jobId: values.job } : {}),
        ...(values.peer !== undefined ? { peer: values.peer as TeammateTaskPeer } : {}),
        ...(values.state !== undefined ? { state: values.state as TeammateTaskState } : {}),
        ...(values.kind !== undefined ? { kind: values.kind as TeammateTaskKind } : {}),
      };
      if (Object.keys(filter).length > 0) {
        const report = taskReport.parse(visible);
        const healthy = report.state === 'healthy' && report.ok !== false;
        const tasks = healthy ? (report.tasks ?? []).filter(task => teammateTaskLedgerMatch(task, filter)) : [];
        visible = { ...visible, selection: filter, matched: healthy ? tasks.length > 0 : null, tasks };
      }
    }
    output(JSON.stringify(visible, null, json ? undefined : 2));
    const report = result as { state?: string; ok?: boolean };
    return report.ok === false || ['error', 'unavailable', 'refused'].includes(report.state ?? '') ? 1 : 0;
  } catch {
    const error = parsed ? 'Teammate task operation unavailable; check configuration and task state.' : 'Invalid teammate task arguments.';
    output(json ? JSON.stringify({ error, ...(parsed ? {} : { usage: USAGE }) }) : `${error}${parsed ? '' : `\n${USAGE}`}`);
    return parsed ? 1 : 2;
  }
}
