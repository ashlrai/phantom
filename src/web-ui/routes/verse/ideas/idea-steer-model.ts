/**
 * routes/verse/ideas/idea-steer-model.ts: pure helpers for the Ideas pane
 * "Do next" / "Not now" control. The line built here goes through the existing
 * fleet inbox interject client; nothing here writes files. Idea titles are
 * untrusted backlog text, so they are flattened to one capped line.
 */
export type IdeaVerdict = 'do-next' | 'not-now';

const TITLE_MAX = 160;
const NOTE_MAX = 200;
const VERDICT_TEXT: Record<IdeaVerdict, string> = { 'do-next': 'Do next', 'not-now': 'Not now' };

// Control characters (C0, DEL, C1) and line/paragraph separators become spaces, then whitespace collapses.
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

export function ideaSteerText(idea: { title: string; repo: string }, verdict: IdeaVerdict, note?: string): string | null {
  const title = oneLine(idea.title).slice(0, TITLE_MAX).trim();
  if (!title) return null;
  const body = note === undefined ? '' : oneLine(note).slice(0, NOTE_MAX).trim();
  return `[idea:${oneLine(idea.repo)}] ${VERDICT_TEXT[verdict]}: ${title}${body ? ` · ${body}` : ''}`;
}

export function ideaSteeredLabel(verdict: IdeaVerdict, at: number, now: number): string {
  const what = `Sent: ${VERDICT_TEXT[verdict].toLowerCase()}`;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return `${what} · just now`;
  if (minutes < 60) return `${what} · ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${what} · ${hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`} ago`;
}
