/** Replay one explicit, untrusted snapshot through the production context-pack builder. */
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNodeContextPack } from '../../src/core/fleet/node-context-pack.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';
import { MAX_CONTEXT_PACK_BUDGET, parseContextPackArguments } from '../../src/mcp/context-server.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_BUDGETS = 16;
const usage = 'Use --file SNAPSHOT --budgets N[,N...] [--emit-budget N].';

type Dependencies = {
  read?: typeof readStableRegularFile;
  build?: typeof buildNodeContextPack;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

/** Reads once, then returns an exit code without modifying process state. */
export function runContextReplay(args: string[], deps: Dependencies = {}): number {
  const stdout = deps.stdout ?? (text => process.stdout.write(text));
  const stderr = deps.stderr ?? (text => process.stderr.write(text));
  const fail = (code: string, message: string, exit: number): number => {
    stderr(`${JSON.stringify({ schemaVersion: 1, status: 'error', error: { code, message } })}\n`);
    return exit;
  };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--file', '--budgets', '--emit-budget'].includes(key) ||
        value === undefined || values.has(key)) return fail('INVALID_ARGUMENTS', usage, 2);
    values.set(key, value);
  }
  const file = values.get('--file');
  const budgetText = values.get('--budgets');
  const emitText = values.get('--emit-budget');
  const validBudget = (value: string): boolean => /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value)) && Number(value) <= MAX_CONTEXT_PACK_BUDGET;
  const parts = budgetText?.split(',') ?? [];
  if (!file?.trim() || file.startsWith('-') || file.includes('\0') || parts.length === 0 ||
      parts.length > MAX_BUDGETS || !parts.every(validBudget) || new Set(parts).size !== parts.length ||
      (emitText !== undefined && (!validBudget(emitText) || !parts.includes(emitText)))) {
    return fail('INVALID_ARGUMENTS', usage, 2);
  }

  try {
    const absolute = resolve(file);
    const read = (deps.read ?? readStableRegularFile)(absolute, {
      anchorPath: dirname(absolute), maxFileBytes: MAX_SNAPSHOT_BYTES, remainingBytes: MAX_SNAPSHOT_BYTES,
    });
    if (!read.ok) {
      const invalid = ['per-file-byte-limit', 'byte-limit', 'unsafe-file'].includes(read.reason);
      return fail('SNAPSHOT_UNAVAILABLE', 'Snapshot unavailable.', invalid ? 2 : 1);
    }
    let raw: unknown;
    try { raw = JSON.parse(read.text) as unknown; }
    catch { return fail('INVALID_SNAPSHOT', 'Snapshot must be valid JSON.', 2); }
    let snapshot: ReturnType<typeof parseContextPackArguments>;
    try { snapshot = parseContextPackArguments(raw); }
    catch { return fail('INVALID_SNAPSHOT', 'Snapshot has an invalid shape or exceeds context limits.', 2); }

    let selected = '';
    const reports = parts.map(part => {
      const budget = Number(part);
      const pack = (deps.build ?? buildNodeContextPack)({ ...snapshot, byteBudget: budget });
      if (part === emitText) selected = pack;
      const records = pack.split('\n').filter(Boolean).map(line =>
        JSON.parse(line) as { jobId: string; kind: 'task' | 'output'; truncated: boolean });
      const cited = new Set(records.map(record => record.jobId));
      return {
        budget,
        bytes: Buffer.byteLength(pack, 'utf8'),
        includedCitations: records.map(({ jobId, kind }) => ({ jobId, kind })),
        truncatedCitations: records.filter(record => record.truncated).map(({ jobId, kind }) => ({ jobId, kind })),
        missingUpstreamIds: [...new Set(snapshot.node.upstreamJobIds)].filter(id => !cited.has(id)),
      };
    });
    const report = `${JSON.stringify({ schemaVersion: 1, status: 'ready', jobId: snapshot.node.jobId, reports })}\n`;
    if (emitText !== undefined) {
      stderr(report);
      stdout(selected);
    } else stdout(report);
    return 0;
  } catch {
    return fail('REPLAY_FAILED', 'Could not replay snapshot.', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runContextReplay(process.argv.slice(2));
}
