/**
 * `phm comms-agent status|run|drafts [--status pending|sent|all] [--transport <transport>] [--json]`.
 * `phm comms-agent inbox [--transport <transport>] [--class <class>] [--contains <text>] [--limit <n>] [--json]`.
 * Thin handler. The role, triage and send policy live in src/core/comms-agent/.
 */
import { COMMS_DRAFT_STATUSES, commsDrafts, commsInbox, commsStatus, runCommsAgent, type CommsDraftsFilter, type CommsDraftStatusFilter, type CommsInboxFilter } from '../core/comms-agent/run.js';
import { isCommsTransport } from '../core/comms-agent/policy.js';
import { MAIL_CLASSES, type MailClass } from '../core/comms-agent/triage.js';
import { commsRunsRoot } from '../core/comms-agent/store.js';

const USAGE = `phm comms-agent status [--dir <runs>] [--json]
phm comms-agent run [--lanes <lane,lane>] [--dir <runs>] [--json]
phm comms-agent drafts [--status pending|sent|all] [--transport <transport>] [--dir <runs>] [--json]
phm comms-agent inbox [--transport <transport>] [--class <class>] [--contains <text>] [--limit <n>] [--dir <runs>] [--json]
The Comms role is under the Leader. The router picks the lane; none is hard-coded.
Sends require an owner standing approval. See docs/COMMS-AGENT.md.`;

const VERBS = ['status', 'run', 'drafts', 'inbox'] as const;

function emit(json: boolean, value: unknown): void {
  console.log(JSON.stringify(value, null, json ? undefined : 2));
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Inbox file') || message.startsWith('Comms agent directory') || message === 'Refusing a symlink.' || message === 'Approval overrides are refused.') return message;
  return 'Comms agent run failed.';
}

export async function cmdCommsAgent(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const help = args.includes('--help') || args.includes('-h');
  const valueOf = (flag: string): { ok: true; value?: string } | { ok: false } => {
    const index = args.indexOf(flag);
    if (index < 0) return { ok: true };
    const value = args[index + 1];
    if (!value || value.startsWith('-')) return { ok: false };
    return { ok: true, value };
  };
  const dir = valueOf('--dir');
  const lanesFlag = valueOf('--lanes');
  const statusFlag = valueOf('--status');
  const transportFlag = valueOf('--transport');
  const classFlag = valueOf('--class');
  const containsFlag = valueOf('--contains');
  const limitFlag = valueOf('--limit');
  if (!dir.ok || !lanesFlag.ok || !statusFlag.ok || !transportFlag.ok || !classFlag.ok || !containsFlag.ok || !limitFlag.ok) {
    emit(json, { ok: false, error: 'Missing value for flag. See phm comms-agent --help.' });
    return 2;
  }
  const consumed = new Set<number>();
  for (const flag of ['--dir', '--lanes', '--status', '--transport', '--class', '--contains', '--limit']) {
    const index = args.indexOf(flag);
    if (index >= 0) { consumed.add(index); consumed.add(index + 1); }
  }
  const rest = args.filter((arg, index) => arg !== '--json' && arg !== '--help' && arg !== '-h' && !consumed.has(index));
  if (help) {
    if (json) emit(true, { usage: USAGE });
    else console.log(USAGE);
    return 0;
  }
  if (rest.length === 0) {
    emit(json, { ok: false, error: 'Use phm comms-agent status|run|drafts|inbox --json' });
    if (!json) console.error(USAGE);
    return 2;
  }
  const [verb, ...extra] = rest;
  const usageFail = (): number => {
    emit(json, { ok: false, error: 'Use phm comms-agent status|run|drafts|inbox --json' });
    if (!json) console.error(USAGE);
    return 2;
  };
  if (extra.length > 0 || !VERBS.includes(verb as typeof VERBS[number]) || rest.some(arg => arg.startsWith('-'))) {
    return usageFail();
  }
  // Filter flags narrow one read each and are a usage error on the others:
  // --status picks the drafts slice, --transport narrows drafts and inbox,
  // and --class/--contains/--limit narrow the inbox page only.
  const draftsFilter: CommsDraftsFilter = {};
  const inboxFilter: CommsInboxFilter = {};
  const filterFlagUsed = statusFlag.value !== undefined || transportFlag.value !== undefined
    || classFlag.value !== undefined || containsFlag.value !== undefined || limitFlag.value !== undefined;
  if ((verb === 'status' || verb === 'run') && filterFlagUsed) return usageFail();
  if (verb === 'drafts' && (classFlag.value !== undefined || containsFlag.value !== undefined || limitFlag.value !== undefined)) return usageFail();
  if (verb === 'inbox' && statusFlag.value !== undefined) return usageFail();
  if (verb === 'drafts' || verb === 'inbox') {
    if (transportFlag.value !== undefined) {
      if (!isCommsTransport(transportFlag.value)) return usageFail();
      if (verb === 'drafts') draftsFilter.transport = transportFlag.value;
      else inboxFilter.transport = transportFlag.value;
    }
  }
  if (verb === 'drafts') {
    if (statusFlag.value !== undefined) {
      if (!(COMMS_DRAFT_STATUSES as readonly string[]).includes(statusFlag.value)) return usageFail();
      draftsFilter.status = statusFlag.value as CommsDraftStatusFilter;
    }
  }
  if (verb === 'inbox') {
    if (classFlag.value !== undefined) {
      if (!(MAIL_CLASSES as readonly string[]).includes(classFlag.value)) return usageFail();
      inboxFilter.class = classFlag.value as MailClass;
    }
    if (containsFlag.value !== undefined) inboxFilter.contains = containsFlag.value;
    if (limitFlag.value !== undefined) {
      const limit = Number(limitFlag.value);
      if (!Number.isInteger(limit) || limit < 1) return usageFail();
      inboxFilter.limit = limit;
    }
  }
  const runsDir = commsRunsRoot(dir.value);
  const lanes = lanesFlag.value ? lanesFlag.value.split(',').map(lane => lane.trim()).filter(Boolean) : [];
  try {
    if (verb === 'status') {
      emit(json, await commsStatus(runsDir));
      return 0;
    }
    if (verb === 'drafts') {
      emit(json, await commsDrafts(runsDir, draftsFilter));
      return 0;
    }
    if (verb === 'inbox') {
      emit(json, await commsInbox(runsDir, {}, inboxFilter));
      return 0;
    }
    emit(json, await runCommsAgent({ runsDir, lanes }));
    return 0;
  } catch (error) {
    emit(json, { ok: false, error: publicError(error) });
    return 1;
  }
}
