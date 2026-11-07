/** List allowlisted teammate iMessages still waiting for a reply; --answered marks rowids handled. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { markTeammateTextsAnswered, readTeammateTexts } from '../core/comms/imessage-teammate-inbox.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet teammate-texts [--runs-dir <path>] [--since <minutes>] [--answered <rowid,...>] [--json]';
const MAX_SINCE_MINUTES = 99_999;

export interface FleetTeammateTextsDeps {
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Overrides --runs-dir / ASHLR_RUNS_DIR / ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
}

export async function cmdFleetTeammateTexts(args: string[], deps: FleetTeammateTextsDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output(`${usage}\nList iMessage texts from allowlisted senders other than the verified owner, oldest first, with age in minutes.\n--answered marks rowids replied to and prints how many were newly marked. Exit 2 on invalid arguments.`);
    return 0;
  }
  let runsFlag: string | undefined;
  let sinceMs: number | undefined;
  let answeredFlag: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' || arg === '--since' || arg === '--answered') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return invalid();
      if (arg === '--runs-dir') runsFlag = value;
      else if (arg === '--answered') {
        if (!/^\d+(,\d+)*$/.test(value)) return invalid();
        answeredFlag = value;
      } else {
        if (!/^\d{1,5}$/.test(value)) return invalid();
        const minutes = Number(value);
        if (minutes > MAX_SINCE_MINUTES) return invalid();
        sinceMs = minutes * 60_000;
      }
    } else return invalid();
  }
  const runsDir = runsFlag ?? deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = deps.now ?? (() => Date.now());

  if (answeredFlag !== undefined) {
    const rowids = answeredFlag.split(',').map(Number);
    const marked = markTeammateTextsAnswered(rowids, runsDir, new Date(now()));
    if (json) output(JSON.stringify({ v: 1, marked }));
    else output(`marked ${marked} answered`);
    return 0;
  }

  const { sourceState, texts } = readTeammateTexts({ runsDir, sinceMs, now });
  if (json) {
    output(JSON.stringify({ v: 1, sourceState, texts }));
    return 0;
  }
  for (const t of texts) {
    const preview = scrubSecrets(t.text).replace(/\s+/g, ' ').trim().slice(0, 80);
    output(`${t.ageMinutes}m  ${t.rowid}  ${t.senderId}  ${preview}`);
  }
  const oldest = texts[0];
  output(oldest ? `${texts.length} waiting, oldest ${oldest.ageMinutes}m` : '0 waiting');
  return 0;

  function invalid(): number {
    error(`error: invalid arguments. ${usage}`);
    return 2;
  }
}
