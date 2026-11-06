/** Offline supervisor-command reconciliation. No dispatch or mutation authority. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LeaderOutput { name: string; text: string; at: number }
export interface BetTraceReaders {
  leaderOutputs(): Promise<readonly LeaderOutput[]>;
  queueLines(): Promise<string | null>;
  jobMetrics(): Promise<string | null>;
  slots(): Promise<unknown>;
}
type State = 'queued' | 'launched' | 'finished' | 'precheck_skip' | 'lost' | 'pending' | 'unknown' | 'applied' | 'overwritten';
interface Command {
  line: number;
  kind: 'BET' | 'FIXUP' | 'SLOTS';
  id?: string;
  repo?: string;
  lane?: string;
  tier?: string;
  target?: number;
  currentTarget?: number | null;
  state: State;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const rank: Partial<Record<State, number>> = { queued: 1, launched: 2, finished: 3, precheck_skip: 3 };

export async function readBetTrace(readers: BetTraceReaders, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid observation time');
  const [outputs, queue, metrics, slots] = await Promise.all([
    readers.leaderOutputs(), readers.queueLines(), readers.jobMetrics(), readers.slots(),
  ]);
  const jobs = new Map<string, State>();
  let metricsHealthy = metrics !== null;
  for (const line of (metrics ?? '').split(/\r?\n/).filter(line => line.trim())) {
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(line)); } catch { metricsHealthy = false; continue; }
    const id = row.job ?? row.job_id ?? row.id;
    if (typeof id !== 'string') { metricsHealthy = false; continue; }
    const event = row.event ?? row.state;
    const state: State = event === 'precheck_skip' || row.outcome === 'precheck_skip' ? 'precheck_skip'
      : ['finish', 'finished', 'complete', 'completed', 'outcome'].includes(String(event)) ? 'finished'
      : ['launch', 'launched', 'start', 'started'].includes(String(event)) ? 'launched'
      : ['enqueue', 'queued', 'enqueued'].includes(String(event)) ? 'queued' : 'unknown';
    const previous = jobs.get(id);
    if (!previous || (rank[state] ?? 0) >= (rank[previous] ?? 0)) jobs.set(id, state);
  }
  // Token matching avoids treating RQ-ABCQ8-RETRY as evidence for RQ-ABCQ8.
  const queued = new Set((queue ?? '').match(/\bRQ-[A-Za-z0-9_-]+\b/g) ?? []);
  const rawSlots = object(slots);
  const lanes = object(rawSlots.lanes ?? rawSlots);
  const passes = [...outputs].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)).map(output => {
    const commands: Command[] = [];
    for (const [index, line] of output.text.split(/\r?\n/).entries()) {
      const bet = /^BET\s+(\S+)\s+(\S+)\s+(\S+)\s+([A-Za-z0-9_-]+)\s+\S.*$/.exec(line);
      const fix = /^FIXUP\s+(\S+)\s+([A-Za-z0-9_-]+)\s+\S.*$/.exec(line);
      const slot = /^SLOTS\s+(\S+)\s+(\d+)\s*$/.exec(line);
      if (slot) {
        const target = Number(slot[2]);
        const value = lanes[slot[1]!];
        const currentTarget = count(object(value).target ?? value);
        commands.push({ line: index + 1, kind: 'SLOTS', lane: slot[1]!, target, currentTarget,
          state: !Number.isSafeInteger(target) || currentTarget === null ? 'unknown' : target === currentTarget ? 'applied' : 'overwritten' });
      } else if (bet || fix) {
        const id = bet ? `RQ-${bet[4]}Q8` : `RQ-FIXUP-${fix![2]}Q8`;
        const age = now - output.at;
        const state = jobs.get(id) ?? (queued.has(id) ? 'queued'
          : !metricsHealthy || queue === null || !Number.isFinite(age) ? 'unknown'
          : age > 5 * 60_000 ? 'lost' : 'pending');
        commands.push({ line: index + 1, kind: bet ? 'BET' : 'FIXUP', id,
          repo: (bet ?? fix)![1]!, ...(bet ? { lane: bet[2]!, tier: bet[3]! } : {}), state });
      }
    }
    const totals = Object.fromEntries((['queued', 'launched', 'finished', 'precheck_skip', 'lost', 'pending', 'unknown', 'applied', 'overwritten'] as const)
      .map(state => [state, commands.filter(command => command.state === state).length]));
    return { source: output.name, at: Number.isFinite(output.at) ? new Date(output.at).toISOString() : null, commands, totals };
  });
  return { schema: 'fleet.bet-trace.v1', generatedAt: new Date(now).toISOString(), passes };
}

/** Epoch seconds/milliseconds and compact UTC filenames; mtime for other TS formats. */
function outputTime(name: string, fallback: number): number {
  const ts = name.slice(4, -4);
  if (/^\d{10}(?:\d{3})?$/.test(ts)) return Number(ts) * (ts.length === 10 ? 1000 : 1);
  const compact = /^(\d{4})(\d{2})(\d{2})[T_-]?(\d{2})(\d{2})(\d{2})Z?$/.exec(ts);
  const parsed = Date.parse(compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : ts);
  return Number.isFinite(parsed) ? parsed : fallback;
}
export function defaultBetTraceReaders(root = join(homedir(), '.ashlr-runs')): BetTraceReaders {
  const optional = async (path: string): Promise<string | null> => {
    try { return await readFile(join(root, path), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  return {
    async leaderOutputs() {
      const dir = join(root, 'supervisor');
      let names: string[];
      try { names = await readdir(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      return Promise.all(names.filter(name => /^out\..+\.txt$/.test(name)).map(async name => {
        const path = join(dir, name);
        const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        return { name: `supervisor/${name}`, text, at: outputTime(name, info.mtimeMs) };
      }));
    },
    async queueLines() {
      const texts = await Promise.all(['queue/router-queue.md', 'queue/ready.tsv'].map(optional));
      return texts.every(text => text === null) ? null : texts.filter(text => text !== null).join('\n');
    },
    jobMetrics: () => optional('metrics/jobs.jsonl'),
    async slots() { const text = await optional('queue/slots.json'); return text === null ? null : JSON.parse(text) as unknown; },
  };
}

export async function cmdFleetBetTrace(args: string[], readers?: BetTraceReaders, now = Date.now()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: ashlr fleet bet-trace [--json]\nRead-only supervisor BET/FIXUP/SLOTS reconciliation.\n'); return 0;
  }
  try {
    if (args.some(arg => arg !== '--json')) throw new Error('Usage: ashlr fleet bet-trace [--json]');
    const report = await readBetTrace(readers ?? defaultBetTraceReaders(), now);
    process.stdout.write(args.includes('--json') ? JSON.stringify(report) + '\n' : report.passes.map(pass =>
      `${pass.source}: ${JSON.stringify(pass.totals)}\n${pass.commands.map(command => `  ${command.kind} ${command.id ?? command.lane} ${command.state}`).join('\n')}`).join('\n') + '\n');
    return report.passes.some(pass => pass.totals.lost! > 0) ? 1 : report.passes.some(pass => pass.totals.unknown! > 0) ? 2 : 0;
  } catch {
    process.stdout.write(args.includes('--json') ? JSON.stringify({ schema: 'fleet.bet-trace.v1', error: 'Unable to read trace sources or invalid arguments' }) + '\n' : 'Unable to read trace sources or invalid arguments\n');
    return 2;
  }
}
