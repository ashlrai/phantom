import { isAbsolute, join } from 'node:path';
import { canonicalResourceLedgerJson } from '../pool-ledger-json.js';

export const GROKBOT_KINDS = ['connector', 'browser', 'desktop', 'message-mason', 'approval'] as const;
export interface GrokbotTask {
  schema: 'grokbot-task.v1';
  id: string;
  kind: typeof GROKBOT_KINDS[number];
  goal: string;
  inputs: Record<string, string>;
  budget_cap: number;
  reply_to: string;
  deadline: string;
}
export interface GrokbotResult {
  schema: 'grokbot-result.v1';
  id: string;
  status: 'succeeded' | 'failed' | 'needs-approval';
  summary: string;
}
export function refuse(reason: string): never { throw new Error(`grokbot: ${reason}`); }
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',');
}
export function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
}
// Defense in depth, not a general secret classifier. Callers must supply public
// task descriptions and opaque connector object IDs, never credential material.
export function safeJson(value: unknown): string {
  const json = canonicalResourceLedgerJson(value, { maxBytes: 16_384, maxContainerEntries: 64, maxDepth: 4 });
  if (!json || /(?:phm_|Bearer\s|-----BEGIN|(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|secret|token|api[_-]?key|authorization|cookie|credential)["\s]*[:=])/i.test(json)) {
    refuse('unsafe-or-oversized-data');
  }
  return json;
}
export function parseTask(value: unknown, now: number, replyRoot?: string): GrokbotTask {
  safeJson(value);
  if (!record(value) || !exact(value, ['schema', 'id', 'kind', 'goal', 'inputs', 'budget_cap', 'reply_to', 'deadline']) ||
      value.schema !== 'grokbot-task.v1' || !identifier(value.id) ||
      !GROKBOT_KINDS.includes(value.kind as GrokbotTask['kind']) ||
      typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 4096 ||
      !record(value.inputs) || !Object.entries(value.inputs).every(([key, item]) =>
        /^[a-z][a-z0-9_]{0,63}$/.test(key) && typeof item === 'string' && item.length <= 1024) ||
      !count(value.budget_cap) || value.budget_cap !== 1 ||
      typeof value.reply_to !== 'string' || !isAbsolute(value.reply_to) ||
      (replyRoot !== undefined && value.reply_to !== join(replyRoot, `${value.id}.json`)) ||
      !timestamp(value.deadline) || Date.parse(value.deadline) <= now || Date.parse(value.deadline) > now + 86_400_000) {
    refuse('invalid-task');
  }
  return JSON.parse(JSON.stringify(value)) as GrokbotTask;
}
export function parseResult(value: unknown, id: string): GrokbotResult {
  safeJson(value);
  if (!record(value) || !exact(value, ['schema', 'id', 'status', 'summary']) ||
      value.schema !== 'grokbot-result.v1' || value.id !== id ||
      !['succeeded', 'failed', 'needs-approval'].includes(String(value.status)) ||
      typeof value.summary !== 'string' || value.summary.length > 4096) refuse('invalid-result');
  return value as unknown as GrokbotResult;
}
