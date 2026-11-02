import type { FleetJobTextV1 } from '../../../../core/fleet/runs-job-texts.js';

export function closesRefs(text: string): number[] {
  const issues = new Set<number>();
  const pattern = /(?:^|\s)(?:closes|fixes|resolves)\s*:?\s+#(\d+)(?![\w]|\.\d)/gim;
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) issues.add(number);
    if (issues.size === 10) break;
  }
  return [...issues];
}

export function notesPreview(text: string, maxLines = 40): { lines: string[]; more: number } {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  const limit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : 0;
  return { lines: lines.slice(0, limit), more: Math.max(0, lines.length - limit) };
}

export function notesHeadline(text: FleetJobTextV1 | null | undefined): string {
  if (text == null) return 'Notes not in this build';
  if (text.state === 'missing') return 'No bridge notes yet';
  if (text.state === 'unreadable') return 'Bridge notes unreadable';
  const preview = notesPreview(text.text, 0);
  return `Bridge notes · ${preview.more} lines${text.truncated ? ' · truncated' : ''}`;
}
