/**
 * pr-title.ts — real pull-request titles for the Mac bridge publish step.
 *
 * Bridge jobs are identified by RQ ids. The publish step now titles each PR
 * `type(scope): summary`, at or under 72 display characters, derived from the
 * worktree diff through a local model or from the router queue line when no
 * model answer is usable. The RQ id moves into the PR body and stays the
 * last-resort title when every better source fails.
 *
 * Pure where possible: the model call is injected, so tests never touch a
 * local server. `createLoopbackCompleter` is the only I/O seam; it refuses
 * non-loopback endpoints through the local-inference URL gate.
 */

import { assertPermitted, endpointPermitted } from '../policy/local-only.js';
import { validateLocalBaseUrl } from '../run/local-inference.js';

export const PR_TITLE_MAX_CHARS = 72;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const SCOPE = /^[a-z0-9][a-z0-9._-]{0,29}$/;
const CONVENTIONAL = /^(feat|fix|docs|test|ci|refactor|perf|chore|build|revert|style)(\([a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}\))?:\s+\S/;
const ROUTER_ENVELOPE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*\(([^()]*)\)\s*:\s*/;
const MAX_DIFF_CHARS = 16_000;
const MAX_LINE_CHARS = 4_000;

export interface PrTitle {
  title: string;
  source: 'model' | 'router-line' | 'fallback';
}
export type PrTitleCompleter = (prompt: string) => Promise<string>;

/** Collapse to one printable single-line string. */
function cleanInline(text: string): string {
  // eslint-disable-next-line no-control-regex -- control bytes are exactly what must not reach a PR title
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Word-boundary truncation at `max` chars; never emits trailing dangling punctuation. */
export function truncateTitle(text: string, max = PR_TITLE_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundary = cut.lastIndexOf(' ');
  const base = (boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, max))
    .replace(/[\s.,;:!?\-–—/\\()[\]{}"'`]+$/, '');
  return base || text.slice(0, max).trimEnd();
}

/** Any candidate line becomes a safe ≤72-char title; empty input falls back to the job id. */
export function normalizeTitle(raw: string, jobId: string): string {
  const job = JOB_ID.test(jobId) ? jobId : 'bridge-job';
  const text = cleanInline(raw.split('\n', 1)[0] ?? '').replace(/^[\s'"`]+|[\s'"`]+$/g, '');
  return text ? truncateTitle(text) : truncateTitle(job);
}

const TYPE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(fix|bug|bugfix|regression|hotfix|repair|broken|incorrect|crash)\b/i, 'fix'],
  [/\b(test|tests|testing|coverage|vitest|fixture)\b/i, 'test'],
  [/\b(docs?|document|documentation|readme|guide|comment)\b/i, 'docs'],
  [/\b(ci|workflow|pipeline|typecheck|lint|gate)\b/i, 'ci'],
  [/\b(refactor|clean ?up|simplif|restructure|rename|dedup)\b/i, 'refactor'],
  [/\b(perf|performance|optimi[sz]e|speed|faster|latency|throughput)\b/i, 'perf'],
  [/\b(revert|rollback|back[ -]out)\b/i, 'revert'],
  [/\b(deps|dependency|upgrade|bump|packag)\b/i, 'build'],
  [/\b(add|implement|introduce|support|create|feat|enable|wire|new)\b/i, 'feat'],
];

/** Best-effort conventional-commit type from free text; 'chore' when nothing matches. */
export function inferType(text: string): string {
  for (const [pattern, type] of TYPE_RULES) if (pattern.test(text)) return type;
  return 'chore';
}

function sanitizeScope(raw: string | undefined): string | null {
  const scope = raw?.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return scope && SCOPE.test(scope) ? scope : null;
}

/** Most-changed logical area from `+++ b/` diff paths: conventional scope material. */
export function scopeFromDiff(diff: string): string | null {
  const counts = new Map<string, number>();
  for (const match of diff.matchAll(/^\+\+\+ b\/([^\t\n]+)/gm)) {
    const parts = match[1]!.split('/');
    let key = parts[0]!;
    // src/{core,cli}/<module>/... scopes to the module; other src areas keep theirs.
    if (key === 'src' && parts.length > 1) {
      key = (parts[1] === 'core' || parts[1] === 'cli') && parts.length > 2 ? parts[2]! : parts[1]!;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
  return sanitizeScope(best ?? undefined);
}

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(?:\s|$)/.exec(text);
  return (match?.[1] ?? text).slice(0, 240);
}

interface RouterMeta { scope: string | null; task: string }
function parseRouterLine(line: string): RouterMeta {
  const match = ROUTER_ENVELOPE.exec(line);
  if (!match) return { scope: null, task: line };
  const fields = new Map<string, string>();
  for (const entry of match[2]!.split(',')) {
    const eq = entry.indexOf('=');
    if (eq > 0) fields.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return { scope: sanitizeScope(fields.get('repo')), task: line.slice(match[0].length) };
}

/**
 * Title from the router queue line (`JOB (meta): task text`). Strips the
 * envelope and a leading `VISION <family>.` marker, keeps the first sentence,
 * and composes `type(scope): summary`. Never throws; worst case is the job id.
 */
export function titleFromRouterLine(line: string, jobId: string): PrTitle {
  const text = cleanInline((line ?? '').split('\n', 1)[0] ?? '').slice(0, MAX_LINE_CHARS);
  if (!text) return { title: normalizeTitle('', jobId), source: 'fallback' };
  const { scope, task } = parseRouterLine(text);
  const summary = firstSentence(task.replace(/^VISION\s+\S+[.:;]?\s*/i, ''))
    .replace(/[.!?\s]+$/, '').replace(/^\w/, (c) => c.toLowerCase());
  if (!summary) return { title: normalizeTitle('', jobId), source: 'fallback' };
  const type = inferType(task);
  const title = truncateTitle(scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`);
  return { title: title || normalizeTitle('', jobId), source: 'router-line' };
}

/** Prompt the local model for a conventional-commit title; the diff is untrusted data. */
export function buildDiffTitlePrompt(diff: string): string {
  return [
    'Summarize the following git diff as exactly one conventional-commit pull request title.',
    'Format: type(scope): summary — a single line of at most 60 characters, lowercase type,',
    'no quotes, no trailing period. Allowed types: feat fix docs test ci refactor perf chore build revert style.',
    'Reply with only the title.',
    '',
    '```diff',
    diff.slice(0, MAX_DIFF_CHARS),
    '```',
  ].join('\n');
}

/**
 * Title from the model's answer. A conventional line is kept verbatim; a bare
 * summary is wrapped with the inferred type and the diff-derived scope.
 * Unusable answers return null so the caller can fall back.
 */
export function titleFromModelAnswer(raw: string, diff: string, jobId: string): string | null {
  const text = cleanInline((raw ?? '').split('\n', 1)[0] ?? '').replace(/^[\s'"`]+|[\s'"`]+$/g, '');
  if (!text || text.toLowerCase() === jobId.toLowerCase()) return null;
  if (CONVENTIONAL.test(text)) return truncateTitle(text);
  const scope = scopeFromDiff(diff);
  const summary = text.replace(/^\w/, (c) => c.toLowerCase()).replace(/[.!?\s]+$/, '');
  if (!summary) return null;
  // A docs/test/ci-only diff defaults its type to the touched area.
  const inferred = inferType(summary);
  const type = inferred !== 'chore' ? inferred : ['docs', 'test', 'ci'].includes(scope ?? '') ? scope! : 'chore';
  return truncateTitle(scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`);
}

/**
 * Diff → title through the injected local model. Any model error, unusable
 * answer or oversized prompt resolves to the job (RQ) id.
 */
export async function titleFromDiff(diff: string, jobId: string, complete: PrTitleCompleter): Promise<PrTitle> {
  try {
    const title = titleFromModelAnswer(await complete(buildDiffTitlePrompt(diff)), diff, jobId);
    if (title) return { title, source: 'model' };
  } catch { /* model errors always degrade to the RQ id */ }
  return { title: normalizeTitle('', jobId), source: 'fallback' };
}

export interface LoopbackCompleterOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible chat completer pinned to loopback by the local-inference
 * URL gate. Returns null for a non-loopback or invalid endpoint: the caller
 * then falls back rather than sending the diff off-host.
 */
export function createLoopbackCompleter(options: LoopbackCompleterOptions = {}): PrTitleCompleter | null {
  const checked = validateLocalBaseUrl(options.baseUrl ?? 'http://127.0.0.1:11434/v1');
  if (!checked.ok || !checked.loopback) return null;
  const model = options.model?.trim();
  if (!model) return null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (prompt: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      assertPermitted(endpointPermitted(checked.baseUrl));
      const response = await fetchImpl(`${checked.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0.2,
          max_tokens: 48,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('local model refused');
      const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('local model returned no title');
      return content;
    } finally {
      clearTimeout(timer);
    }
  };
}
