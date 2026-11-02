/** Split into lines that keep their terminators; the last line may lack one. */
export function unionLines(text: string): string[] {
  return text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Lines in `text` not consumed matching `original` in order; null when an original line is missing. */
export function unionAddedLines(original: string, text: string): string[] | null {
  const originalLines = unionLines(original);
  const added: string[] = [];
  let i = 0;
  for (const line of unionLines(text)) {
    if (i < originalLines.length && line === originalLines[i]) i++;
    else added.push(line);
  }
  return i === originalLines.length ? added : null;
}

/** Conservative classification of a single diff3 conflict hunk. */
export function classifyUnionConflict(base: string, ours: string, theirs: string): 'union-safe' | 'needs-model' {
  const left = unionAddedLines(base, ours);
  const right = unionAddedLines(base, theirs);
  return left && right && left.length > 0 && right.length > 0 && JSON.stringify(left) !== JSON.stringify(right)
    ? 'union-safe' : 'needs-model';
}

/** Inspect all diff3 hunks in a file; malformed or ambiguous markers fail closed. */
export function classifyDiff3(text: string): 'union-safe' | 'needs-model' {
  const lines = unionLines(text);
  let state: 'outside' | 'ours' | 'base' | 'theirs' = 'outside';
  let ours = '', base = '', theirs = '', count = 0;
  for (const line of lines) {
    if (line === '<<<<<<< ours\n' && state === 'outside') { state = 'ours'; ours = ''; base = ''; theirs = ''; }
    else if (line === '||||||| base\n' && state === 'ours') state = 'base';
    else if (line === '=======\n' && state === 'base') state = 'theirs';
    else if (line === '>>>>>>> theirs\n' && state === 'theirs') {
      if (classifyUnionConflict(base, ours, theirs) !== 'union-safe') return 'needs-model';
      count++; state = 'outside';
    } else if (/^(<{7}|\|{7}|={7}|>{7})/.test(line)) return 'needs-model';
    else if (state === 'ours') ours += line;
    else if (state === 'base') base += line;
    else if (state === 'theirs') theirs += line;
  }
  return count > 0 && state === 'outside' ? 'union-safe' : 'needs-model';
}
