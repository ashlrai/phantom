import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { addIntent, updateIntent, type IntentAddInput, type IntentUpdateInput } from './edit.js';
import { isIntentStatus, normalizeRq, MAX_RQ } from './schema.js';

export function validNativeEdit(name: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const args = raw as Record<string, unknown>;
  const add = name === 'intent_add';
  const allowed = add ? ['title', 'source', 'owner', 'rq', 'status', 'verbatim', 'staleAfterMs', 'partial'] :
    ['id', 'title', 'source', 'owner', 'rq', 'status', 'evidence', 'partial'];
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (add ? typeof args.title !== 'string' || typeof args.source !== 'string' :
    typeof args.id !== 'string' || !/^int-[0-9a-f]{16}$/.test(args.id)) return false;
  for (const key of ['title', 'source', 'owner']) if (key in args && (typeof args[key] !== 'string' || !(args[key] as string).trim())) return false;
  if ('status' in args && (typeof args.status !== 'string' || !isIntentStatus(args.status))) return false;
  for (const key of ['partial', 'verbatim']) if (key in args && typeof args[key] !== 'boolean') return false;
  if ('staleAfterMs' in args && (!Number.isSafeInteger(args.staleAfterMs) || (args.staleAfterMs as number) < 60000 || (args.staleAfterMs as number) > 31536000000)) return false;
  if ('rq' in args) {
    if (!Array.isArray(args.rq) || args.rq.length > MAX_RQ || args.rq.some(key => typeof key !== 'string')) return false;
    try { args.rq.forEach((key: string) => normalizeRq(key)); } catch { return false; }
  }
  if ('evidence' in args && (typeof args.evidence !== 'string' || !args.evidence.trim())) return false;
  return true;
}

export async function nativeEdit(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const root = fixedOwnerRunsDir();
    if (name === 'intent_add') return { ok: true, item: await addIntent(args as unknown as IntentAddInput, root) };
    const { id, evidence, ...patch } = args;
    return { ok: true, item: await updateIntent(id as string, { ...patch, ...(evidence !== undefined ? { evidence: { ref: evidence as string } } : {}) } as IntentUpdateInput, root) };
  } catch {
    return { error: 'Intent edit failed.' };
  }
}
