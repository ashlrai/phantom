/**
 * What a session's job has done, for its card on the Conversations wall: the
 * newest recorded step and how long ago, the size of its diff, the commands
 * seen in its log, its helpers and its pull request. Every value is one the
 * wall's own read carries (`work`, `session.helpers`, `session.prUrl`); none
 * is taken out of the summary's prose. A session with no job, or a server
 * that sends no `work`, gets no line for it and keeps its summary whole. A
 * part the read could not measure says "unknown", never 0.
 */
import { sessionAge } from '../../../../core/fleet/live-sessions.js';
import type { WallEntry } from './session-wall-model.js';

/** What the vitals are read from: a wall entry, or an opened conversation, which carries the same keys. */
export type VitalsSubject = Pick<WallEntry, 'work'> & { session: Pick<WallEntry['session'], 'helpers' | 'prUrl'> };

export interface CardVitals {
  /** The newest recorded step. `ago` is null when the step or the read carries no usable time. */
  step: { event: string; summary: string; ago: string | null } | null;
  /** Null: no work was read for this session. 'unknown': it was, and the change read did not answer. */
  diff: { files: number; added: number; removed: number; partial: boolean } | 'unknown' | null;
  /** Null: no work was read. 'unknown': the log's commands could not be read. */
  commands: number | 'unknown' | null;
  /** Null when the session has no helpers below it, or the read did not say. */
  helpers: { below: number; running: number; failed: number } | null;
  pr: { url: string; number: string } | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Measured between the step's time and the read's, both the server's clock, so a skewed screen clock never changes it. */
function stepAgo(at: string | null, generatedAt: string): string | null {
  const then = at === null ? Number.NaN : Date.parse(at), now = Date.parse(generatedAt);
  const seconds = Math.floor((now - then) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? sessionAge(seconds) : null;
}

export function cardVitals(entry: VitalsSubject, generatedAt: string): CardVitals {
  const { work, session } = entry;
  const number = session.prUrl?.match(/\/pull\/(\d+)\/?$/)?.[1];
  return {
    step: work?.step ? { event: work.step.event, summary: work.step.summary, ago: stepAgo(work.step.at, generatedAt) } : null,
    diff: work === null ? null : work.files === null ? 'unknown' : { files: work.files.count, added: work.files.added, removed: work.files.removed, partial: work.files.partial },
    commands: work === null ? null : work.commands ?? 'unknown',
    helpers: session.helpers !== null && session.helpers.below > 0 ? session.helpers : null,
    pr: session.prUrl && number ? { url: session.prUrl, number } : null,
  };
}

/** True when the card has a vitals line to draw inside its button (the pull request link sits outside it). */
export const hasVitals = (vitals: CardVitals) => vitals.step !== null || vitals.diff !== null || vitals.commands !== null || vitals.helpers !== null;

export const stepWhen = (step: NonNullable<CardVitals['step']>) => (step.ago === null ? 'time unknown' : `${step.ago} ago`);
export function diffWords(diff: NonNullable<CardVitals['diff']>): string {
  if (diff === 'unknown') return 'Changed files unknown';
  return `${plural(diff.files, 'file')} changed, ${diff.added} added, ${diff.removed} removed${diff.partial ? ' (partial: the change read was cut short)' : ''}`;
}
export const commandsWords = (commands: number | 'unknown') => (commands === 'unknown' ? 'commands unknown' : plural(commands, 'command'));
export function helpersWords(helpers: NonNullable<CardVitals['helpers']>): string {
  return `${helpers.running} of ${plural(helpers.below, 'helper')} running${helpers.failed > 0 ? `, ${helpers.failed} failed` : ''}`;
}

/**
 * The summary sentences a card still shows once its vitals are drawn. The
 * server writes one sentence for each of these values (session-thread.ts
 * `summaryOf`); a sentence is left out only when the value it states is on
 * the card as a vital, so nothing is said twice and nothing is lost. A
 * sentence that does not start the way the server writes it stays.
 */
export function summaryLeft(summary: readonly string[], vitals: CardVitals): string[] {
  return summary.filter(line => !(
    (vitals.pr !== null && line.startsWith('Pull request: '))
    || (vitals.step !== null && line.startsWith('Latest step: '))
    || (vitals.commands !== null && vitals.diff !== null && /^(?:\d+ commands? seen|Commands unknown), /.test(line))
    || (vitals.helpers !== null && /^\d+ of \d+ helpers? running/.test(line))));
}
