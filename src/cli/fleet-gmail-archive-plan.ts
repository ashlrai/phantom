import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { archivePlan, classifyGmailHeuristic, EML_INBOX_READ_MAX, readEmlInboxDetailed } from '../core/comms/gmail-eml-adapter.js';
import { writeGmailArchivePlanLatest } from '../core/comms/gmail-archive-plan-latest.js';

const USAGE = `Usage: ashlr fleet gmail-archive-plan --dir <eml dir> [--inbox <label>] [--target <n>] [--scan <n>] [--runs-dir <dir>] [--json] [--no-save]
Propose which saved messages to archive to keep unread at --target or fewer (default 100). The newest --scan messages are read (bounded, default ${EML_INBOX_READ_MAX}, never more).
Archive only on a local export: no mail is moved, sent or deleted, and saved files carry no unread flag, so counts describe the scanned sample, not the live inbox.
The plan is saved under <runs-dir>/comms/gmail-archive-plan-latest.json (one entry per --inbox); --no-save skips that.`;

/** "Name <a@b.test>" or "a@b.test" to a lowercase address. */
const senderOf = (from: string): string => (/<([^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

export async function cmdFleetGmailArchivePlan(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let dir: string | undefined;
  let inbox: string | undefined;
  let target = 100;
  let scan = EML_INBOX_READ_MAX;
  let runsDir = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  let json = false;
  let save = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--no-save') save = false;
    else if ((arg === '--dir' || arg === '--inbox' || arg === '--target' || arg === '--scan' || arg === '--runs-dir') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--dir') dir = value; else if (arg === '--inbox') inbox = value; else if (arg === '--runs-dir') runsDir = value;
      else if (!/^\d{1,6}$/.test(value)) { console.error('Invalid arguments.'); return 2; }
      else if (arg === '--target') target = Number(value); else scan = Number(value);
    } else { console.error('Invalid arguments.'); return 2; }
  }
  if (!dir) { console.error('Missing --dir.'); return 2; }
  let read;
  try { read = readEmlInboxDetailed(dir, { limit: scan }); }
  catch { console.error('Mail directory is missing or unreadable.'); return 2; }
  const messages = read.messages;
  const plan = archivePlan(messages, messages.map(m => classifyGmailHeuristic(m)), target);
  const chosen = new Set(plan.archiveCandidates);
  const counts = new Map<string, number>();
  for (const m of messages) if (chosen.has(m.id)) counts.set(senderOf(m.from), (counts.get(senderOf(m.from)) ?? 0) + 1);
  const topSenders = [...counts].map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender)).slice(0, 3);
  if (save) {
    try { writeGmailArchivePlanLatest(runsDir, { inbox: inbox ?? basename(dir), unread: plan.unread, target: plan.target, archiveCount: chosen.size, topSenders }); }
    catch { console.error('Could not save the archive plan.'); }
  }
  const scope = { source: 'local-eml-export', scanned: messages.length, files: read.scope.files,
    limit: read.scope.limit, truncated: read.scope.truncated, unreadRepresentsLiveTotal: false };
  if (json) console.log(JSON.stringify({ schema: 'fleet.gmail-archive-plan.v1', archivePlan: plan, topSenders, scope }));
  else {
    console.log(`Would archive ${chosen.size} of ${scope.scanned} scanned messages (target ${plan.target}). Archive only, nothing is deleted.`);
    if (scope.truncated) console.log(`Only the newest ${scope.limit} of ${scope.files} saved messages were scanned; this sample is not the live inbox's unread total.`);
    for (const s of topSenders) console.log(`${s.count} from ${s.sender}`);
  }
  return 0;
}
