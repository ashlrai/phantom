import { constants } from 'node:fs';
import { z } from 'zod';
import { checkpointSession, listSessionHandoffs, parseSessionHandoffListArgs, planSessionResume, planSessionFailover, readSessionHandoff } from '../core/agents/session-handoff.js';
import { HANDOFF_RECORD_BYTES, handoffId, handoffModel, handoffTier, handoffSignalSchema } from '../core/agents/session-handoff-schema.js';
import { rejectUnknownOptions } from './args.js';

const USAGE = 'phm checkpoint handoff save <request.json> <runs-dir> <worktree> | plan|failover <request.json> | show <runs-dir> <job> | list <runs-dir> [--state open|completed] [--job <id>] [--lane <id>] [--repo <owner/name>] [--signal <kind>] [--pressure] [--since <15m|2h|1d|ISO|epoch-ms>] [--before <15m|2h|1d|ISO|epoch-ms>] [--json]';
const LIST_VALUE_FLAGS = ['--state', '--job', '--lane', '--repo', '--signal', '--since', '--before'] as const;
const saveSchema = z.object({ draft: z.unknown(), signal: handoffSignalSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const planSchema = z.object({ runs: z.string(), worktree: z.string(), job: handoffId, attempt: handoffId,
  repo: z.string(), lane: handoffId, model: handoffModel, tier: handoffTier, owner: handoffId, capabilities: z.array(handoffId).max(32) }).strict();
const failoverSchema = z.object({ options: planSchema, candidates: z.array(z.object({ lane: handoffId,
  model: handoffModel, tier: handoffTier, capabilities: z.array(handoffId).max(32), available: z.boolean(),
  remainingFraction: z.number().min(0).max(1).nullable() }).strict()).max(32) }).strict();

/**
 * The `list` verb's own argv slice: exactly one runs dir plus the shared
 * filter flags. `rejectUnknownOptions` proves every dash token is an accepted
 * flag before this walk mirrors its consumption — a value flag takes the next
 * token whatever it looks like — so positionals are exactly the non-flag
 * tokens. A repeated flag keeps its first occurrence, the same rule the other
 * filter parsers apply.
 */
function parseListArgs(more: string[]): { runs?: string; args?: Record<string, unknown>; error?: string } {
  const bad = rejectUnknownOptions(more, { flags: ['--pressure'], values: LIST_VALUE_FLAGS });
  if (bad) return { error: bad.message };
  const positionals: string[] = [];
  const args: Record<string, unknown> = {};
  for (let i = 0; i < more.length; i++) {
    const token = more[i]!;
    if (token === '--') { positionals.push(...more.slice(i + 1)); break; }
    if (token === '--pressure') { args.pressure ??= true; continue; }
    if ((LIST_VALUE_FLAGS as readonly string[]).includes(token)) {
      const key = token.slice(2);
      args[key] ??= more[i + 1];
      i++;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) return {};
  return { runs: positionals[0], args };
}

export async function cmdSessionHandoff(args: string[]): Promise<number> {
  if (args.includes('--help') || args[0] === 'help') { console.log(USAGE); return 0; }
  const rest = args.filter(arg => arg !== '--json');
  const [verb, ...more] = rest;
  const refuse = (error?: string) => {
    process.stderr.write(`${error === undefined ? '' : `${error}\n`}${USAGE}\n`);
    return 2;
  };
  if (args.length - rest.length > 1) return refuse();
  if (verb === 'list') {
    const parsed = parseListArgs(more);
    if (parsed.error !== undefined) return refuse(parsed.error);
    if (parsed.runs === undefined) return refuse();
    const filter = parseSessionHandoffListArgs(parsed.args ?? {});
    if (!filter.ok) return refuse(filter.error);
    try {
      console.log(JSON.stringify(listSessionHandoffs(parsed.runs, filter.filter)));
      return 0;
    } catch { process.stderr.write('Session handoff refused; check request, journal, capabilities and repository state.\n'); return 2; }
  }
  if (more.some(arg => arg.startsWith('-')) ||
    !((verb === 'save' && more.length === 3) || (['plan', 'failover'].includes(verb) && more.length === 1) ||
      (verb === 'show' && more.length === 2))) {
    return refuse();
  }
  try {
    let result: unknown;
    if (verb === 'show') result = readSessionHandoff(more[0], more[1]);
    else {
      // Read at most one bounded request; no raw input or parser errors enter diagnostics.
      const { open } = await import('node:fs/promises');
      const file = await open(more[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: Buffer;
      try {
        if (!(await file.stat()).isFile()) throw new Error('Invalid request');
        raw = Buffer.alloc(HANDOFF_RECORD_BYTES + 1);
        const read = await file.read(raw, 0, raw.length, 0);
        if (read.bytesRead > HANDOFF_RECORD_BYTES) throw new Error('Oversized request');
        raw = raw.subarray(0, read.bytesRead);
      } finally { await file.close(); }
      const request: unknown = JSON.parse(raw.toString('utf8'));
      if (verb === 'failover') {
        const parsed = failoverSchema.parse(request);
        result = await planSessionFailover(parsed.options, parsed.candidates);
      } else result = verb === 'save'
          ? await checkpointSession({ ...saveSchema.parse(request), runs: more[1], worktree: more[2] })
          : await planSessionResume(planSchema.parse(request));
    }
    console.log(JSON.stringify(result)); return 0;
  } catch { process.stderr.write('Session handoff refused; check request, journal, capabilities and repository state.\n'); return 2; }
}
