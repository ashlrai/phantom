// ask.v1 and ask.status.v1 (RQ-ONEASK-1-SCHEMA, `phm do`, flag oneAsk). Frozen contract:
// specs/ONE-ASK-FLOW.md sections 3 and 4; schemas in schema/ask.v1. Fail closed: schema errors,
// cross-field rules and secret-shaped strings all reject. Errors carry paths, never values.
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { validateWorkbench } from '../workbench/schema.js';

export const ASK_SCHEMA_DIR = join(__dirname, '..', '..', '..', 'schema', 'ask.v1');
export const ASK_STATES = ['refused', 'queued', 'claimed', 'running', 'verifying', 'pr_open', 'in_merge_queue',
  'merged', 'reverted', 'publish_only', 'failed'] as const;
export type AskState = (typeof ASK_STATES)[number];
export const REFUSAL_REASONS = ['multi_repo', 'github_path', 'tier1_path', 'hold_list', 'bad_repo', 'bad_path',
  'over_budget', 'flag_off', 'secret_shape', 'no_pool'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface AskV1 {
  schema: 'ask.v1'; id: string; text: string; repo: string; paths: string[]; tier: 'work' | 'mid' | 'frontier';
  acceptance: string[]; budget: { tokens_max: number; usd_max: number; wall_s_max: number }; n: number;
  pools_allowed: string[]; state: AskState; created_ts: string; job_ids: string[]; pr: number | null;
  pr_url: string | null; refusal_reason: RefusalReason | null;
}
export interface AskStatusV1 {
  schema: 'ask.status.v1'; ask_id: string; job_id: string | null; state: AskState; pool: string | null; ts: string;
  pr: number | null; pr_url: string | null; merged_at: string | null; reverted_at: string | null;
  checks: 'pending' | 'success' | 'failure' | null; reason: string | null; tokens_total: number | null; wall_s: number | null;
}

function secretPaths(v: unknown, path: string, out: string[]): void {
  if (typeof v === 'string') {
    if (scrubSecrets(v) !== v) out.push(`${path}: secret_shape`);
  } else if (Array.isArray(v)) v.forEach((x, i) => secretPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) secretPaths(x, `${path}.${k}`, out);
}

function common(name: string, data: unknown): string[] {
  const errors = validateWorkbench(ASK_SCHEMA_DIR, name, data);
  secretPaths(data, '$', errors);
  return errors;
}

/** Validate an ask.v1 record. Empty array means valid. */
export function validateAsk(data: unknown): string[] {
  const errors = common('ask', data);
  if (errors.length) return errors;
  const a = data as AskV1;
  if ((a.state === 'refused') !== (a.refusal_reason !== null)) errors.push('$.refusal_reason: state');
  if (a.job_ids.length > a.n) errors.push('$.job_ids: n');
  if ((a.pr === null) !== (a.pr_url === null) || (a.pr_url && !a.pr_url.endsWith(`/pull/${a.pr}`))) errors.push('$.pr_url: pr');
  if (a.pr_url && !a.pr_url.includes(`/${a.repo}/pull/`)) errors.push('$.pr_url: repo');
  return errors;
}

/** Validate an ask.status.v1 event. Empty array means valid. */
export function validateAskStatus(data: unknown): string[] {
  const errors = common('ask-status', data);
  if (errors.length) return errors;
  const s = data as AskStatusV1;
  const needPr: AskState[] = ['pr_open', 'in_merge_queue', 'merged', 'reverted'];
  if (needPr.includes(s.state) && (s.pr === null || s.pr_url === null)) errors.push('$.pr: state');
  if ((s.state === 'merged' || s.state === 'reverted') && s.merged_at === null) errors.push('$.merged_at: state');
  if ((s.state === 'reverted') !== (s.reverted_at !== null)) errors.push('$.reverted_at: state');
  if (s.state === 'refused' && !(REFUSAL_REASONS as readonly string[]).includes(s.reason ?? '')) errors.push('$.reason: state');
  return errors;
}

/** Value-free view for logs and audit rows: drops the ask text and acceptance strings, keeps lengths. */
export function askLogView(a: AskV1): Record<string, unknown> {
  const { text, acceptance, ...rest } = a;
  return { ...rest, text_len: text.length, acceptance_count: acceptance.length };
}
