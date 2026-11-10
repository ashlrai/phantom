import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { archivePlan, classifyGmailHeuristic, readEmlInbox } from '../core/comms/gmail-eml-adapter.js';
import { writeGmailArchivePlanLatest } from '../core/comms/gmail-archive-plan-latest.js';

const USAGE = 'Usage: ashlr fleet gmail-archive-plan --dir <eml dir> [--inbox <label>] [--target <n>] [--runs-dir <dir>] [--json] [--no-save]\nPropose which of up to 100 saved messages to archive to keep unread at 100 or fewer. Archive only: no mail is moved, sent or deleted.\nThe plan is saved under <runs-dir>/comms/gmail-archive-plan-latest.json (one entry per --inbox); --no-save skips that.';

/** "Name <a@b.test>" or "a@b.test" to a lowercase address. */
const senderOf = (from: string): string => (/<([^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

export async function cmdFleetGmailArchivePlan(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let dir: string | undefined;
  let inbox: string | undefined;
  let target = 100;
  let runsDir = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  let json = false;
  let save = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--no-save') save = false;
    else if ((arg === '--dir' || arg === '--inbox' || arg === '--target' || arg === '--runs-dir') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--dir') dir = value; else if (arg === '--inbox') inbox = value; else if (arg === '--runs-dir') runsDir = value;
      else if (/^\d{1,6}$/.test(value)) target = Number(value); else { console.error('Invalid arguments.'); return 2; }
    } else { console.error('Invalid arguments.'); return 2; }
  }
  if (!dir) { console.error('Missing --dir.'); return 2; }
  let messages;
  try { messages = readEmlInbox(dir); }
  catch { console.error('Mail directory is missing or unreadable.'); return 2; }
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
  if (json) console.log(JSON.stringify({ schema: 'fleet.gmail-archive-plan.v1', archivePlan: plan, topSenders }));
  else {
    console.log(`Would archive ${chosen.size} of ${plan.unread} unread (target ${plan.target}). Archive only, nothing is deleted.`);
    for (const s of topSenders) console.log(`${s.count} from ${s.sender}`);
  }
  return 0;
}
