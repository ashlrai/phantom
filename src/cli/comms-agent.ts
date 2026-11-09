/**
 * `phm comms-agent status|run|drafts [--json]`.
 * Thin handler. The role, triage and send policy live in src/core/comms-agent/.
 */
import { commsDrafts, commsStatus, runCommsAgent } from '../core/comms-agent/run.js';
import { commsRunsRoot } from '../core/comms-agent/store.js';

const USAGE = `phm comms-agent status [--dir <runs>] [--json]
phm comms-agent run [--lanes <lane,lane>] [--dir <runs>] [--json]
phm comms-agent drafts [--dir <runs>] [--json]
The Comms role is under the Leader. The router picks the lane; none is hard-coded.
Sends require an owner standing approval. See docs/COMMS-AGENT.md.`;

const VERBS = ['status', 'run', 'drafts'] as const;

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
  if (!dir.ok || !lanesFlag.ok) {
    emit(json, { ok: false, error: 'Missing value for flag. See phm comms-agent --help.' });
    return 2;
  }
  const consumed = new Set<number>();
  for (const flag of ['--dir', '--lanes']) {
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
    emit(json, { ok: false, error: 'Use phm comms-agent status|run|drafts --json' });
    if (!json) console.error(USAGE);
    return 2;
  }
  const [verb, ...extra] = rest;
  if (extra.length > 0 || !VERBS.includes(verb as typeof VERBS[number]) || rest.some(arg => arg.startsWith('-'))) {
    emit(json, { ok: false, error: 'Use phm comms-agent status|run|drafts --json' });
    if (!json) console.error(USAGE);
    return 2;
  }
  const runsDir = commsRunsRoot(dir.value);
  const lanes = lanesFlag.value ? lanesFlag.value.split(',').map(lane => lane.trim()).filter(Boolean) : [];
  try {
    if (verb === 'status') {
      emit(json, await commsStatus(runsDir));
      return 0;
    }
    if (verb === 'drafts') {
      emit(json, await commsDrafts(runsDir));
      return 0;
    }
    emit(json, await runCommsAgent({ runsDir, lanes }));
    return 0;
  } catch (error) {
    emit(json, { ok: false, error: publicError(error) });
    return 1;
  }
}
