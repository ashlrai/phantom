import { listLeaderFiles } from '../core/fleet/library-files.js';
import { LIBRARY_ID, parseLibraryFilter, readLibrary, readLibraryItem, type LibraryItem } from '../core/fleet/library.js';
const usage = 'phm library [--json|--text] [--kind file|media|memory|message|context] [--since 1h] [--q text]';
const showUsage = 'phm library show <id> [--json]';
/** Reader seams so tests drive the CLI from fixtures. */
export interface LibraryCliDeps { read?: typeof readLibrary; readItem?: typeof readLibraryItem }
const size = (bytes: number | null): string => bytes === null ? 'size unknown' : `${bytes} bytes`;
const row = (item: LibraryItem): string =>
  `${item.title} (${item.kind})\n  ${item.source} · by ${item.owner ?? 'unknown'} · ${item.asOf} · ${size(item.size)}\n  ${item.preview}`;
async function show(args: string[], deps: LibraryCliDeps): Promise<number> {
  const json = args.includes('--json'), rest = args.filter(arg => arg !== '--json');
  if (rest.length !== 1 || args.length - rest.length > 1 || !LIBRARY_ID.test(rest[0]!)) {
    console.error(`Usage: ${showUsage}\nIds look like memory:0123456789abcdef; list them with phm library --json.`); return 2;
  }
  try {
    const result = await (deps.readItem ?? readLibraryItem)(rest[0]!);
    if (json) console.log(JSON.stringify(result));
    else if (result.item) console.log(`${row(result.item)}\n  id ${result.item.id}`);
    else console.log(result.unavailable.length ? `Not found. Unavailable sources: ${result.unavailable.join(', ')}.` : 'No Library item has that id.');
    return result.item ? 0 : 1;
  } catch { console.error('Library unavailable. Try again.'); return 1; }
}
export async function cmdLibrary(args: string[], deps: LibraryCliDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(`${usage}\n${showUsage} — print one item\nphm library list [--json] — list leader files (read-only)`); return 0;
  }
  if (args[0] === 'show') return show(args.slice(1), deps);
  if (args[0] === 'list') {
    if (args.slice(1).some(arg => arg !== '--json') || args.length > 2) {
      console.error('Usage: phm library list [--json]'); return 2;
    }
    const files = await listLeaderFiles();
    if (args.includes('--json')) console.log(JSON.stringify({ files }));
    else for (const file of files) console.log(`${file.name}  ${file.size} bytes  ${file.modifiedAt}\n  ${file.preview}`);
    return 0;
  }
  const input: Record<string, string> = {};
  let format: string | undefined;
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json' || arg === '--text') {
        if (format) throw new Error();
        format = arg;
      } else {
        const key = arg.slice(2), value = args[++i];
        if (!['--kind', '--since', '--q'].includes(arg) || key in input || value === undefined || value.startsWith('--')) throw new Error();
        input[key] = value;
      }
    }
    parseLibraryFilter(input);
  } catch { console.error(`Usage: ${usage}`); return 2; }
  try {
    const snapshot = await (deps.read ?? readLibrary)(parseLibraryFilter(input));
    if (format === '--json') console.log(JSON.stringify(snapshot));
    else {
      for (const item of snapshot.items) console.log(`${row(item)}\n  id ${item.id}`);
      if (snapshot.unavailable.length) console.log(`Unavailable sources: ${snapshot.unavailable.join(', ')}.`);
      else if (!snapshot.items.length) console.log('No matching Library items.');
    }
    return 0;
  } catch { console.error('Library unavailable. Try again.'); return 1; }
}
