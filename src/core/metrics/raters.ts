/**
 * Pluggable, async, sampled PR raters. Grading never blocks shipping: it runs
 * after merge, off the critical path, on a sample, and writes `pr.rated`
 * events. Default rater is a local model; external graders (e.g. Jev /
 * TypeSafe AI, see docs/JEV-INTEGRATION.md) plug in through the same interface.
 */
import { createHash } from 'node:crypto';
import type { PrRef } from './telemetry.js';

export interface RatingInput { pr: PrRef; title: string; summary: string }
export interface RatingResult { rating: number /* 1..5 */; confidence?: number; rubric: string }
export interface Rater { id: string; rate(input: RatingInput): Promise<RatingResult> }

export const RUBRIC = 'Upside-weighted: leverage and user impact first; ambition is rewarded; only regressions count against.';

/** Deterministic sampling by PR identity so every machine samples the same PRs. */
export function sampled(pr: PrRef, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const h = parseInt(createHash('sha256').update(`${pr.repo}#${pr.number}`).digest('hex').slice(0, 8), 16);
  return h / 0xffffffff < rate;
}

/** Local model rater: any OpenAI-compatible local endpoint call, injected. */
export function localModelRater(complete: (prompt: string) => Promise<string>): Rater {
  return {
    id: 'local-model',
    async rate({ title, summary }) {
      const out = await complete(`${RUBRIC}\nRate this merged PR 1-5. Reply with only the number.\nTitle: ${title}\n${summary.slice(0, 2000)}`);
      const n = Number(out.match(/[1-5]/)?.[0]);
      return { rating: Number.isFinite(n) && n >= 1 ? n : 3, rubric: RUBRIC };
    },
  };
}

/**
 * Jev adapter interface. `ask` is the caller's Jev/TypeSafe client (credential
 * resolved via Phantom Secrets by the caller); Phantom ships no key and makes
 * no network call here.
 */
export interface JevAsk { (state: string, options: string[]): Promise<{ label: string; confidence: number }> }
export function jevRater(ask: JevAsk): Rater {
  return {
    id: 'jev',
    async rate({ title, summary }) {
      const r = await ask(`${RUBRIC}\n${title}\n${summary.slice(0, 4000)}`, ['1', '2', '3', '4', '5']);
      return { rating: Math.min(5, Math.max(1, Number(r.label) || 3)), confidence: r.confidence, rubric: RUBRIC };
    },
  };
}

/**
 * Async grading queue with bounded concurrency. Failures are dropped (grading
 * is best-effort). Returns ratings for the sampled subset only.
 */
export async function gradeBatch(items: RatingInput[], rater: Rater, opts: { sampleRate?: number; concurrency?: number } = {}): Promise<{ input: RatingInput; result: RatingResult; rater: string }[]> {
  const queue = items.filter((i) => sampled(i.pr, opts.sampleRate ?? 1));
  const out: { input: RatingInput; result: RatingResult; rater: string }[] = [];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try { out.push({ input: it, result: await rater.rate(it), rater: rater.id }); } catch { /* best effort */ }
    }
  });
  await Promise.all(workers);
  return out;
}
