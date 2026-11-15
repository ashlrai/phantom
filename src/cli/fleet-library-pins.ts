import { addPin, LibraryPinError, listPins, removePin, type LibraryPinsOptions } from '../core/fleet/library-pins.js';

const usage = `Usage: ashlr fleet library-pins [--json]
       ashlr fleet library-pins add --kind memory|bus|file|note --ref <ref> --title <title> [--json]
       ashlr fleet library-pins remove <id> [--json]`;

export async function cmdFleetLibraryPins(args: string[], options: LibraryPinsOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  const verb = rest[0] && !rest[0].startsWith('--') ? rest.shift()! : 'list';
  try {
    if (verb === 'list' && rest.length === 0) {
      const pins = listPins(options);
      if (json) console.log(JSON.stringify({ v: 1, pins }));
      else if (!pins.length) console.log('No library pins.');
      else for (const pin of pins) console.log(`${pin.id}  ${pin.kind.padEnd(6)}  ${pin.title}  (${pin.ref})`);
      return 0;
    }
    if (verb === 'add') {
      const values = new Map<string, string>();
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i]!;
        if (!['--kind', '--ref', '--title'].includes(flag) || values.has(flag) || rest[i + 1] === undefined) { console.error(usage); return 2; }
        values.set(flag, rest[++i]!);
      }
      const pin = addPin({ kind: values.get('--kind') ?? '', ref: values.get('--ref') ?? '', title: values.get('--title') ?? '' }, options);
      console.log(json ? JSON.stringify({ v: 1, pin }) : `Pinned ${pin.id}: ${pin.title}`);
      return 0;
    }
    if (verb === 'remove' && rest.length === 1) {
      const removed = removePin(rest[0]!, options);
      if (json) console.log(JSON.stringify({ v: 1, removed }));
      else console.log(removed ? `Removed ${rest[0]}.` : `No pin ${rest[0]}.`);
      return removed ? 0 : 1;
    }
    console.error(usage);
    return 2;
  } catch (error) {
    console.error(error instanceof LibraryPinError ? error.message : 'Library pins failed. Check ~/.phantom permissions and retry.');
    return error instanceof LibraryPinError && verb === 'add' ? 2 : 1;
  }
}
