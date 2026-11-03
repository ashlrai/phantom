import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendInboxEntry } from './mason-inbox.js';
import { listNeedsMason, resolveNeedsMason, type NeedsMasonOptions, type NeedsMasonResolveResult } from './needs-mason-resolve.js';

export type NeedsMasonRelayResult = NeedsMasonResolveResult & { inbox: 'appended' | 'skipped' | 'failed' };

/** Relay desktop answers to the planner after the durable resolution succeeds. */
export async function resolveNeedsMasonWithInbox(
  input: unknown,
  options: NeedsMasonOptions & { appendInbox?: typeof appendInboxEntry } = {},
): Promise<NeedsMasonRelayResult> {
  const runsDir = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const resolvedOptions = { ...options, runsDir };
  const fields = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const item = listNeedsMason(resolvedOptions).find(candidate => candidate.id === fields.itemId);
  const result = resolveNeedsMason(input, resolvedOptions);
  const reply = typeof fields.reply === 'string' ? fields.reply.trim() : '';
  if (!result.ok || result.duplicate || !reply) return { ...result, inbox: 'skipped' };
  try {
    const appended = await (options.appendInbox ?? appendInboxEntry)(
      `Re needs-you ${result.itemId} ("${(item?.text ?? '').slice(0, 160)}"): ${reply}`,
      { runsDir, source: 'Phantom desktop', ...(options.now ? { now: () => new Date(options.now!()) } : {}) },
    );
    return { ...result, inbox: appended.ok ? 'appended' : 'failed' };
  } catch {
    // Bus and marker writes already succeeded; an inbox failure cannot undo them.
    return { ...result, inbox: 'failed' };
  }
}
