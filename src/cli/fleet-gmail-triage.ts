import { homedir } from 'node:os';
import { join } from 'node:path';
import { archivePlan, classifyGmailHeuristic, holdingReply, readEmlInbox, summarizeUpdateLine } from '../core/comms/gmail-eml-adapter.js';
import { pollGmailBridge } from '../core/comms/gmail-bridge.js';

const USAGE = 'Usage: ashlr fleet gmail-triage --dir <eml dir> [--runs-dir <dir>] [--json]\nTriage up to 100 saved messages locally. The archive plan covers only this sample; no mail is moved or sent.';

export async function cmdFleetGmailTriage(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let dir: string | undefined;
  let runsDir = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if ((arg === '--dir' || arg === '--runs-dir') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--dir') dir = value; else runsDir = value;
    } else { console.error('Invalid arguments.'); return 2; }
  }
  if (!dir) { console.error('Missing --dir.'); return 2; }
  let messages;
  try { messages = readEmlInbox(dir); }
  catch { console.error('Mail directory is missing or unreadable.'); return 2; }
  const classifications = messages.map(message => classifyGmailHeuristic(message));
  const report = await pollGmailBridge({ readInbox: async () => messages,
    classify: async message => classifyGmailHeuristic(message), composeReply: async message => holdingReply(message),
    summarizeUpdate: async message => summarizeUpdateLine(message), runsDir });
  const plan = archivePlan(messages, classifications);
  if (json) console.log(JSON.stringify({ schema: 'fleet.gmail-triage.v1', report, archivePlan: plan }));
  else {
    console.log(`Scanned: ${report.scanned}; updates: ${report.updates.length}; drafted: ${report.drafted}; review: ${report.review}; failed: ${report.failed}`);
    for (const update of report.updates) console.log(update);
    console.log(`Archive candidates: ${plan.archiveCandidates.length} (sample unread: ${plan.unread}, target: ${plan.target})`);
    for (const id of plan.archiveCandidates.slice(0, 10)) console.log(id);
  }
  return 0;
}
