import { constants } from 'node:fs';
import { z } from 'zod';
import { checkpointSession, listSessionHandoffs, planSessionResume, planSessionFailover, readSessionHandoff } from '../core/agents/session-handoff.js';
import { HANDOFF_RECORD_BYTES, handoffId, handoffModel, handoffTier, handoffSignalSchema } from '../core/agents/session-handoff-schema.js';

const USAGE = 'phm checkpoint handoff save <request.json> <runs-dir> <worktree> | plan|failover <request.json> | show <runs-dir> <job> | list <runs-dir> [--json]';
const saveSchema = z.object({ draft: z.unknown(), signal: handoffSignalSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const planSchema = z.object({ runs: z.string(), worktree: z.string(), job: handoffId, attempt: handoffId,
  repo: z.string(), lane: handoffId, model: handoffModel, tier: handoffTier, owner: handoffId, capabilities: z.array(handoffId).max(32) }).strict();
const failoverSchema = z.object({ options: planSchema, candidates: z.array(z.object({ lane: handoffId,
  model: handoffModel, tier: handoffTier, capabilities: z.array(handoffId).max(32), available: z.boolean(),
  remainingFraction: z.number().min(0).max(1).nullable() }).strict()).max(32) }).strict();

export async function cmdSessionHandoff(args: string[]): Promise<number> {
  if (args.includes('--help') || args[0] === 'help') { console.log(USAGE); return 0; }
  const rest = args.filter(arg => arg !== '--json');
  const [verb, ...more] = rest;
  if (args.length - rest.length > 1 || more.some(arg => arg.startsWith('-')) ||
    !((verb === 'save' && more.length === 3) || (['plan', 'failover'].includes(verb) && more.length === 1) ||
      (verb === 'show' && more.length === 2) || (verb === 'list' && more.length === 1))) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  try {
    let result: unknown;
    if (verb === 'show') result = readSessionHandoff(more[0], more[1]);
    else if (verb === 'list') result = listSessionHandoffs(more[0]);
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
