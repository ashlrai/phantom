export function findMatches(lines: string[], query: string): number[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  return lines.flatMap((line, index) => line.toLowerCase().includes(needle) ? [index] : []);
}

export function nextMatch(matches: number[], current: number | null, dir: 1 | -1): number | null {
  if (matches.length === 0) return null;
  const index = current === null ? -1 : matches.indexOf(current);
  if (index === -1) return matches[dir === 1 ? 0 : matches.length - 1];
  return matches[(index + dir + matches.length) % matches.length];
}

export function matchLabel(matches: number[], current: number | null): string {
  if (matches.length === 0) return 'No matches';
  const index = current === null ? -1 : matches.indexOf(current);
  return index === -1 ? '' : `${index + 1} of ${matches.length}`;
}
