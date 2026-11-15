/**
 * Pure helpers for the Goals pane "Steer" control. The line produced here goes
 * through the existing fleet inbox interject path; nothing here writes files.
 */
const OBJECTIVE_MAX = 120;
const TEXT_MAX = 600;

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function goalSteerText(goal: { id: string; objective: string }, text: string): string | null {
  const body = oneLine(text).slice(0, TEXT_MAX).trim();
  if (!body) return null;
  return `[goal:${oneLine(goal.id)}] ${oneLine(goal.objective).slice(0, OBJECTIVE_MAX).trim()}: ${body}`;
}

export function steeredLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'Steered just now';
  if (minutes < 60) return `Steered ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Steered ${hours}h ago` : `Steered ${Math.floor(hours / 24)}d ago`;
}
