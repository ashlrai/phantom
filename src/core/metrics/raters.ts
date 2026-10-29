/**
 * Pluggable, async, sampled PR raters. Grading never blocks shipping: it runs
 * after merge, off the critical path, on a sample. Callers may persist results
 * as `pr.rated` events. A local model adapter is provided; external graders (e.g. Jev /
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
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Sample rate must be between 0 and 1.');
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
      // Accept the documented single digit and the conventional labeled form;
      // arbitrary text or a failed grader is unknown, never a fabricated score.
      const match = /^(?:Rating:\s*)?([1-5])\s*$/i.exec(out.trim());
      if (!match) throw new Error('The local rater returned an invalid rating.');
      return { rating: Number(match[1]), rubric: RUBRIC };
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
      if (!/^[1-5]$/.test(r.label) || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) throw new Error('The Jev rater returned an invalid rating.');
      return { rating: Number(r.label), confidence: r.confidence, rubric: RUBRIC };
    },
  };
}

/**
 * Async grading queue with bounded concurrency. Failures are dropped (grading
 * is best-effort). Returns ratings for the sampled subset only.
 */
export async function gradeBatch(items: RatingInput[], rater: Rater, opts: { sampleRate?: number; concurrency?: number } = {}): Promise<{ input: RatingInput; result: RatingResult; rater: string }[]> {
  const concurrency = opts.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  const sampleRate = opts.sampleRate ?? 1;
  // Validate options even for an empty batch, before contacting a grader.
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error('Sample rate must be between 0 and 1.');
  const queue = items.filter((i) => sampled(i.pr, sampleRate));
  const out: { input: RatingInput; result: RatingResult; rater: string }[] = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const result = await rater.rate(it);
        if (!Number.isInteger(result.rating) || result.rating < 1 || result.rating > 5 || typeof result.rubric !== 'string'
          || (result.confidence !== undefined && (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1))) continue;
        out.push({ input: it, result, rater: rater.id });
      } catch { /* best effort */ }
    }
  });
  await Promise.all(workers);
  return out;
}
