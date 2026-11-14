/**
 * `ashlr fleet guidance` — durable per-session operator guidance
 * (RQ-PHX-SESSIONGUIDANCEIORECOVER224S, recovered from PR #3297).
 *
 *   append <job> <text...>   queue one scrubbed message for a real job
 *   read <job>               fold the job's guidance file into honest state
 *   list                     aggregate ack state across every session
 *
 * Guidance stays 'queued' until a consumer (dispatchd/launch.sh — a separate
 * Security proposal) appends a valid ack line to the same JSONL file; this
 * verb never delivers to or interrupts a worker. Records land under
 * <runs-dir>/queue/guidance/<job>.jsonl at modes 0700/0600 with every byte
 * scrubbed; reads answer missing/degraded honestly and never throw.
 */
import { isAbsolute } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  appendSessionGuidance,
  listSessionGuidance,
  readSessionGuidance,
} from '../core/fleet/session-guidance-io.js';
import { isGuidanceJobId } from '../core/fleet/session-guidance.js';

const usage = `Usage: ashlr fleet guidance <append|read|list> [args] [--runs-dir <abs>] [--json]
  append <job> [--text <text>] [text words...] [--source <label>]
  read <job>
  list [--limit <n>]
Appends one scrubbed guidance record (4 KiB cap) under <runs-dir>/queue/guidance;
state stays 'queued' until a consumer ack lands — this verb never delivers.
Exit 0 on success, 1 on a typed refusal or read failure, 2 on usage.`;

interface Dependencies {
  runsDir?: string;
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

interface Parsed {
  runsDir?: string;
  json: boolean;
  source?: string;
  limit?: number;
  text?: string;
  positional: string[];
}

function parseArgs(args: string[]): Parsed | null {
  const parsed: Parsed = { json: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !parsed.json) parsed.json = true;
    else if (arg === '--runs-dir') {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return null;
      parsed.runsDir = value;
    } else if (arg === '--source') {
      const value = args[++i];
      if (typeof value !== 'string') return null;
      parsed.source = value;
    } else if (arg === '--limit') {
      const value = args[++i];
      if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
      parsed.limit = Number(value);
    } else if (arg === '--text') {
      const value = args[++i];
      if (typeof value !== 'string') return null;
      parsed.text = value;
    } else if (arg.startsWith('-')) return null;
    else parsed.positional.push(arg);
  }
  return parsed;
}

export async function cmdFleetGuidance(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }

  const sub = args[0];
  if (sub !== 'append' && sub !== 'read' && sub !== 'list') return invalid();
  const parsed = parseArgs(args.slice(1));
  if (parsed === null) return invalid();
  const runsDir = parsed.runsDir ?? deps.runsDir;
  const now = deps.now;

  if (sub === 'list') {
    if (parsed.positional.length > 0) return invalid();
    const result = await listSessionGuidance({ runsDir, now, limit: parsed.limit });
    if (parsed.json) {
      output(JSON.stringify(sanitizePublicJson(result)));
    } else {
      output(`fleet guidance list: ${result.sourceState}, ${result.sessions.length} session(s)`);
      for (const session of result.sessions) {
        output(`${safe(session.job)} pending=${safe(session.pending)} state=${safe(session.latest?.state ?? 'none')} strategy=${safe(session.strategy)}`);
      }
    }
    return result.sourceState === 'degraded' ? 1 : 0;
  }

  const job = parsed.positional[0];
  const rest = parsed.positional.slice(1);
  if (job === undefined || !isGuidanceJobId(job)) return invalid();

  if (sub === 'read') {
    if (rest.length > 0) return invalid();
    const result = await readSessionGuidance(job, { runsDir, now });
    if (parsed.json) {
      output(JSON.stringify(sanitizePublicJson(result)));
    } else {
      output(`fleet guidance read ${safe(job)}: ${result.sourceState}, pending=${result.pending}, entries=${result.entries.length}`);
      for (const entry of result.entries) {
        output(`  ${safe(entry.id)} ${entry.state}${entry.turn === null ? '' : ` turn=${entry.turn}`}${entry.requeueTo === null ? '' : ` -> ${safe(entry.requeueTo)}`} ${safe(entry.text)}`);
      }
    }
    return 0;
  }

  // append
  const text = parsed.text ?? rest.join(' ');
  if (text.trim() === '') return invalid();
  const result = await appendSessionGuidance(job, text, {
    runsDir, now, source: parsed.source,
  });
  if (parsed.json) {
    output(JSON.stringify(sanitizePublicJson(result)));
  } else if (result.ok) {
    output(`fleet guidance append ${safe(job)}: queued id=${safe(result.id)} strategy=${safe(result.strategy)}${result.truncated ? ' (truncated)' : ''}`);
  } else {
    error(`fleet guidance append ${safe(job)} refused: ${result.code}`);
  }
  return result.ok ? 0 : 1;
}
