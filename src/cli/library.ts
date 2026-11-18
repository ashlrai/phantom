import { listLeaderFiles } from '../core/fleet/library-files.js';
import { parseLibraryFilter, readLibrary } from '../core/fleet/library.js';
const usage = 'phm library [--json|--text] [--kind file|memory|message|context] [--since 1h] [--q text]';
export async function cmdLibrary(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(`${usage}\nphm library list [--json] — list leader files (read-only)`); return 0;
  }
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
    const snapshot = await readLibrary(parseLibraryFilter(input));
    if (format === '--json') console.log(JSON.stringify(snapshot));
    else {
      for (const item of snapshot.items) console.log(`${item.title} (${item.kind})\n  ${item.source} · ${item.asOf}\n  ${item.preview}`);
      if (snapshot.unavailable.length) console.log(`Unavailable sources: ${snapshot.unavailable.join(', ')}.`);
      else if (!snapshot.items.length) console.log('No matching Library items.');
    }
    return 0;
  } catch { console.error('Library unavailable. Try again.'); return 1; }
}
