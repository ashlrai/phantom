/**
 * Pure helpers for the Goals pane "Steer" control. The line produced here goes
 * through the existing fleet inbox interject path; nothing here writes files.
 */
const OBJECTIVE_MAX = 120;
const TEXT_MAX = 600;

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

import { relativeTime } from '../../../lib/relative-time.js';
export function goalSteerText(goal: { id: string; objective: string }, text: string): string | null {
  const body = oneLine(text).slice(0, TEXT_MAX).trim();
  if (!body) return null;
  return `[goal:${oneLine(goal.id)}] ${oneLine(goal.objective).slice(0, OBJECTIVE_MAX).trim()}: ${body}`;
}

export function steeredLabel(at: number, now: number): string {
  const reading = relativeTime(at, now);
  return `Steered ${reading ? reading.seconds < 60 ? 'just now' : reading.text : 'at an unknown time'}`;
}
