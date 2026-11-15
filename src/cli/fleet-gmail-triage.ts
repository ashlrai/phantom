import { homedir } from 'node:os';
import { join } from 'node:path';
import { archivePlan, classifyGmailHeuristic, holdingReply, readEmlInboxDetailed, summarizeUpdateLine } from '../core/comms/gmail-eml-adapter.js';
import { pollGmailBridge, type GmailBridgeReport, type GmailMessage } from '../core/comms/gmail-bridge.js';
import { writeGmailTriageLatest } from '../core/comms/gmail-triage-latest.js';

const USAGE = 'Usage: ashlr fleet gmail-triage --dir <eml dir> [--scan <n>] [--target <n>] [--runs-dir <dir>] [--json] [--no-save]\nTriage saved messages locally, newest first. --scan caps how many exported files are examined (default 100, hard max 1000); --target is the unread count the archive plan aims for (default 100). Counts describe this export sample only; no mail is moved or sent, and nothing here measures the live inbox.\nThe latest counts are saved under <runs-dir>/comms/gmail-triage-latest.json; --no-save skips that.';

function parseCountFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    console.error(`Invalid ${name} value: expected a non-negative integer.`);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    console.error(`Invalid ${name} value: expected a non-negative integer.`);
    return undefined;
  }
  return parsed;
}

export async function cmdFleetGmailTriage(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let dir: string | undefined;
  let runsDir = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  let scan: number | undefined;
  let target: number | undefined;
  let json = false;
  let save = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--no-save') save = false;
    else if ((arg === '--dir' || arg === '--runs-dir' || arg === '--scan' || arg === '--target') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--dir') dir = value;
      else if (arg === '--runs-dir') runsDir = value;
      else {
        const parsed = parseCountFlag(arg, value);
        if (parsed === undefined) return 2;
        if (arg === '--scan') scan = parsed; else target = parsed;
      }
    } else { console.error('Invalid arguments.'); return 2; }
  }
  if (!dir) { console.error('Missing --dir.'); return 2; }
  let inbox;
  try { inbox = readEmlInboxDetailed(dir, scan === undefined ? undefined : { limit: scan }); }
  catch { console.error('Mail directory is missing or unreadable.'); return 2; }
  const { messages, scope } = inbox;
  const classifications = messages.map(message => classifyGmailHeuristic(message));
  // pollGmailBridge rejects batches over 100; scan wider by polling bounded slices of the same selection.
  const bridgeDeps = { classify: async (message: GmailMessage) => classifyGmailHeuristic(message),
    composeReply: async (message: GmailMessage) => holdingReply(message),
    summarizeUpdate: async (message: GmailMessage) => summarizeUpdateLine(message), runsDir };
  const polls: GmailBridgeReport[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    polls.push(await pollGmailBridge({ ...bridgeDeps, readInbox: async () => batch }));
  }
  const report: GmailBridgeReport = polls.length === 0
    ? { scanned: 0, updates: [], drafted: 0, review: 0, failed: 0 }
    : { scanned: polls.reduce((n, p) => n + p.scanned, 0), updates: polls.flatMap(p => p.updates),
        drafted: polls.reduce((n, p) => n + p.drafted, 0), review: polls.reduce((n, p) => n + p.review, 0),
        failed: polls.reduce((n, p) => n + p.failed, 0) };
  const plan = archivePlan(messages, classifications, target);
  let persistence: 'saved' | 'skipped' | 'failed' = 'skipped';
  if (save) {
    try {
      writeGmailTriageLatest(runsDir, { dir, scanned: report.scanned, updates: report.updates.length, drafted: report.drafted, review: report.review,
        failed: report.failed, unreadInSample: plan.unread, target: plan.target, archiveCandidateCount: plan.archiveCandidates.length,
        scope: { source: 'local-eml-export', files: scope.files, limit: scope.limit, truncated: scope.truncated } });
      persistence = 'saved';
    } catch {
      persistence = 'failed';
      console.error('Could not save the triage summary; the shared latest result was not updated.');
    }
  }
  if (json) console.log(JSON.stringify({ schema: 'fleet.gmail-triage.v1',
    scope: { source: 'local-eml-export', scanned: messages.length, files: scope.files, limit: scope.limit,
      truncated: scope.truncated, unreadRepresentsLiveTotal: false },
    report, archivePlan: plan, persistence }));
  else {
    console.log(`Scan: ${messages.length} messages from ${scope.files} exported files; read limit ${scope.limit}${scope.truncated ? ' (truncated: more files remain unexamined)' : ''}. Counts describe this export sample, not the live inbox.`);
    console.log(`Scanned: ${report.scanned}; updates: ${report.updates.length}; drafted: ${report.drafted}; review: ${report.review}; failed: ${report.failed}`);
    for (const update of report.updates) console.log(update);
    console.log(`Archive candidates: ${plan.archiveCandidates.length} (sample unread: ${plan.unread}, target: ${plan.target})`);
    for (const id of plan.archiveCandidates.slice(0, 10)) console.log(id);
  }
  return persistence === 'failed' ? 1 : 0;
}
