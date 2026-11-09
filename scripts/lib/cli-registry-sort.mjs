// Canonical layout for the two CLI registries that every command PR used to
// edit at the same spot (the head or tail of one list). Keeping them sorted,
// one entry per line, makes concurrent PRs land in different places so git
// merges them without a conflict. Pure string functions: tests feed fixtures.

const HELP_START = 'export const HELP_ENTRIES: HelpEntry[] = [\n';
const SUB_START = 'const SUBCOMMANDS: Record<string, string[]> = {\n';

function bounds(source, start, end) {
  const from = source.indexOf(start);
  if (from === -1) throw new Error(`registry start marker not found: ${start.trim()}`);
  const bodyStart = from + start.length;
  const bodyEnd = source.indexOf(end, bodyStart);
  if (bodyEnd === -1) throw new Error(`registry end marker not found after: ${start.trim()}`);
  return { bodyStart, bodyEnd };
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HELP_ENTRIES: one `{ cmd: '...' }` line each, ordered by command text. */
export function sortHelpEntriesSource(source) {
  const { bodyStart, bodyEnd } = bounds(source, HELP_START, '\n];');
  const lines = source.slice(bodyStart, bodyEnd).split('\n').filter((line) => line.trim() !== '');
  const keyed = lines.map((line) => {
    const m = /^ {2}\{ cmd: '((?:[^'\\]|\\.)*)'/.exec(line);
    if (!m) throw new Error(`HELP_ENTRIES line is not a single-line { cmd: ... } entry: ${line.slice(0, 80)}`);
    return { key: m[1], line };
  });
  keyed.sort((a, b) => byText(a.key, b.key) || byText(a.line, b.line));
  return source.slice(0, bodyStart) + keyed.map((e) => e.line).join('\n') + source.slice(bodyEnd);
}

/**
 * SUBCOMMANDS: `key: [...]` on one line each, ordered by key. A comment block
 * directly above an entry travels with it.
 */
export function sortSubcommandsSource(source) {
  const { bodyStart, bodyEnd } = bounds(source, SUB_START, '\n};');
  const body = source.slice(bodyStart, bodyEnd).split('\n');
  const entries = [];
  let comments = [];
  let open = null;
  for (const line of body) {
    if (open) {
      open.text += ' ' + line.trim();
      if (line.trim().endsWith('],')) open = null;
      continue;
    }
    if (line.trim() === '') continue;
    if (/^\s*\/\//.test(line)) { comments.push(line.trim()); continue; }
    const m = /^ {2}('[^']+'|[A-Za-z0-9_$-]+): \[(.*)$/.exec(line);
    if (!m) throw new Error(`SUBCOMMANDS line not understood: ${line.slice(0, 80)}`);
    const entry = { key: m[1].replace(/^'|'$/g, ''), keyText: m[1], comments, text: `${m[1]}: [${m[2].trim()}` };
    comments = [];
    entries.push(entry);
    if (!line.trim().endsWith('],')) open = entry;
  }
  if (open || comments.length) throw new Error('SUBCOMMANDS has an unterminated entry or a trailing comment');
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.key)) throw new Error(`SUBCOMMANDS has a duplicate key: ${e.key}`);
    seen.add(e.key);
    e.text = e.text.replace(/\[\s+/, '[').replace(/,?\s*\],$/, '],').replace(/\s{2,}/g, ' ');
  }
  entries.sort((a, b) => byText(a.key, b.key));
  const out = entries.flatMap((e) => [...e.comments.map((c) => `  ${c}`), `  ${e.text}`]);
  return source.slice(0, bodyStart) + out.join('\n') + source.slice(bodyEnd);
}
