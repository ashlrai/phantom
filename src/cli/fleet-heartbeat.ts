/** Read-only fleet heartbeat: how old are the queue tick and each supervisor status file. */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE =
  'Usage: ashlr fleet heartbeat [--max-age <minutes>] [--json]\n' +
  'Age of last_tick in <runs>/queue/status.json and of the header time in each <runs>/supervisor/status-*.md (default --max-age 30). One line per source; STALE when older than --max-age, missing or unreadable. Exits 0 all fresh, 1 any stale, 2 usage.';

const DEFAULT_MAX_AGE_MIN = 30;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SUPERVISOR_FILES = 64;
/** The header is the first lines of the file; a timestamp further down is not a heartbeat. */
const HEADER_LINES = 12;
const STAMP = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?/;

/** Injected so tests use fixtures and never touch the real ~/.ashlr-runs. */
export interface HeartbeatReader {
  /** Raw queue/status.json text, or null when absent. */
  queueStatus(): Promise<string | null>;
  /** Supervisor status-*.md files, name and raw text. */
  supervisorStatuses(): Promise<Array<{ name: string; text: string }>>;
}

export interface FleetHeartbeatDeps {
  reader?: HeartbeatReader;
  now?: () => number;
  runsDir?: string;
}

export interface HeartbeatSource {
  source: string;
  at: string | null;
  ageMinutes: number | null;
  stale: boolean;
  reason?: 'missing' | 'unparseable' | 'old';
}

export interface FleetHeartbeatView {
  v: 1;
  generatedAt: string;
  maxAgeMinutes: number;
  stale: boolean;
  sources: HeartbeatSource[];
}

/** Timestamps without an offset are read as UTC. */
function parseStamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = STAMP.exec(value);
  if (!m) return null;
  let tz = m[3] ?? 'Z';
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const time = m[2]!.length === 5 ? `${m[2]}:00` : m[2]!;
  const ms = Date.parse(`${m[1]}T${time}${tz}`);
  return Number.isFinite(ms) ? ms : null;
}

function queueStamp(text: string | null): number | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parseStamp((parsed as Record<string, unknown>).last_tick);
  } catch {
    return null;
  }
}

function headerStamp(text: string): number | null {
  for (const line of text.split(/\r?\n/).slice(0, HEADER_LINES)) {
    const ms = parseStamp(line);
    if (ms !== null) return ms;
  }
  return null;
}

function judge(source: string, ms: number | null, missing: boolean, nowMs: number, maxMin: number): HeartbeatSource {
  if (ms === null) return { source, at: null, ageMinutes: null, stale: true, reason: missing ? 'missing' : 'unparseable' };
  const ageMinutes = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  const stale = ageMinutes > maxMin;
  return { source, at: new Date(ms).toISOString(), ageMinutes, stale, ...(stale ? { reason: 'old' as const } : {}) };
}

/** Typed API behind the verb; agents call this directly. */
export async function readFleetHeartbeat(reader: HeartbeatReader, nowMs: number, maxAgeMinutes: number): Promise<FleetHeartbeatView> {
  const queueText = await reader.queueStatus().catch(() => null);
  const files = (await reader.supervisorStatuses().catch(() => [])).slice().sort((a, b) => a.name.localeCompare(b.name));
  const sources = [
    judge('queue/status.json', queueStamp(queueText), queueText === null, nowMs, maxAgeMinutes),
    ...files.map(f => judge(`supervisor/${f.name}`, headerStamp(f.text), false, nowMs, maxAgeMinutes)),
  ];
  return { v: 1, generatedAt: new Date(nowMs).toISOString(), maxAgeMinutes, stale: sources.some(s => s.stale), sources };
}

export function fsHeartbeatReader(runsDir: string): HeartbeatReader {
  const read = async (path: string): Promise<string> => (await readFile(path)).subarray(0, MAX_FILE_BYTES).toString('utf8');
  return {
    queueStatus: async () => {
      try { return await read(join(runsDir, 'queue', 'status.json')); } catch { return null; }
    },
    supervisorStatuses: async () => {
      let names: string[];
      try { names = await readdir(join(runsDir, 'supervisor')); } catch { return []; }
      const picked = names.filter(n => /^status-[A-Za-z0-9._-]{1,80}\.md$/.test(n)).sort().slice(0, MAX_SUPERVISOR_FILES);
      const out: Array<{ name: string; text: string }> = [];
      for (const name of picked) {
        try { out.push({ name, text: await read(join(runsDir, 'supervisor', name)) }); } catch { /* unreadable: skipped */ }
      }
      return out;
    },
  };
}

function plainLine(s: HeartbeatSource, maxAge: number): string {
  if (s.ageMinutes === null) return `${s.source}: no time found (${s.reason}) STALE`;
  return `${s.source}: ${s.ageMinutes} min old${s.stale ? ` STALE (over ${maxAge})` : ''}`;
}

export async function cmdFleetHeartbeat(args: string[], deps: FleetHeartbeatDeps = {}): Promise<number> {
  if (args.length > 0 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  let json = false;
  let maxAge = DEFAULT_MAX_AGE_MIN;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const [flag, inline] = token.startsWith('--max-age=') ? ['--max-age', token.slice('--max-age='.length)] : [token, undefined];
    if (!['--json', '--max-age'].includes(flag)) {
      console.error(`error: ${token.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${token}\n${USAGE}`);
      return 2;
    }
    if (seen.has(flag)) {
      console.error(`error: duplicate option: ${flag}\n${USAGE}`);
      return 2;
    }
    seen.add(flag);
    if (flag === '--json') {
      if (inline !== undefined) { console.error(`error: --json takes no value\n${USAGE}`); return 2; }
      json = true;
      continue;
    }
    const raw = inline ?? args[++i];
    if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) {
      console.error(`error: --max-age needs a number of minutes\n${USAGE}`);
      return 2;
    }
    maxAge = Number(raw);
  }

  const runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const reader = deps.reader ?? fsHeartbeatReader(runsDir);
  const view = await readFleetHeartbeat(reader, (deps.now ?? Date.now)(), maxAge);
  if (json) process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  else {
    for (const s of view.sources) console.log(plainLine(s, maxAge));
    console.log(view.stale ? 'Heartbeat: STALE' : 'Heartbeat: ok');
  }
  return view.stale ? 1 : 0;
}
