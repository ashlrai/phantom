/** `phm outbox`: thin handler. Parses argv and prints what core/fleet/outbox-from-log.ts returns. */
import { outboxFromLog, type OutboxFromLogDeps, type OutboxFromLogResult } from '../core/fleet/outbox-from-log.js';

const usage = `Usage: phm outbox from-log [--file <plan-log.md>] [--apply] [--json]
Copy the leader's newest "Reply for Mason" from the plan log into MASON-OUTBOX.md beside it, so Mason hears
it every hour and not only in the daily digest.
  (no flag)   show what would be added; nothing is written or sent
  --apply     append one "## <time> (leader)" entry, then show it in the Leader chat
  --file      the plan log (default: PHANTOM_PLAN_LOG, comms.leaderPlanLogPath, then leader/PLAN-LOG.md)
The same reply is never added twice (matched by its words). No reply block is a no-op, exit 0.
Nothing leaves the team. --json prints schema outbox.from-log.v1.`;

const line = (r: OutboxFromLogResult): string => {
  if (r.status === 'added') return `Added to ${r.outbox}. Leader chat: ${r.chat?.posted.length ?? 0} posted.`;
  if (r.status === 'would-add') return `Would add to ${r.outbox} (run with --apply):\n${r.entry ?? ''}`.trimEnd();
  if (r.status === 'duplicate') return 'Already in the outbox; nothing added.';
  if (r.status === 'no-reply') return 'No "Reply for Mason" block found; nothing to do.';
  return r.reason ?? 'The plan log could not be read.';
};

export async function cmdOutbox(args: string[], deps: OutboxFromLogDeps & { planLog?: string } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const rest = [...args];
  const take = (name: string): boolean => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  const json = take('--json');
  const apply = take('--apply');
  let file: string | undefined;
  const at = rest.indexOf('--file');
  if (at >= 0) { file = rest[at + 1]; rest.splice(at, 2); if (!file || file.startsWith('--')) { console.error(usage); return 2; } }
  if (rest.shift() !== 'from-log' || rest.length) { console.error(usage); return 2; }
  let planLog = deps.planLog;
  if (planLog === undefined) {
    try { planLog = (await import('../core/config.js')).loadConfigReadOnly().comms?.leaderPlanLogPath; } catch { /* default path */ }
  }
  try {
    const result = await outboxFromLog({ ...(file ? { file } : {}), ...(planLog ? { planLog } : {}), apply }, deps);
    console.log(json ? JSON.stringify(result) : line(result));
    return result.status === 'unreadable' ? 1 : 0;
  } catch {
    console.error(json ? JSON.stringify({ error: 'outbox-unavailable' }) : 'The outbox could not be written.');
    return 1;
  }
}
