import { recordFleetAction } from '../core/fleet/action-intent.js';

const USAGE = 'phm fleet act <pause|resume|kill|reassign|set-slot|vision-edit> --dry-run [--path <target>] [--json]';
export async function cmdFleetAct(args: string[], output: (value: unknown) => void = (value) => console.log(JSON.stringify(value))): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { output({ usage: USAGE }); return 0; }
  const [verb, ...rest] = args;
  let path: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (seen.has(arg) || !['--dry-run', '--json', '--path'].includes(arg)) { output({ error: 'usage', usage: USAGE }); return 2; }
    seen.add(arg);
    if (arg === '--path') {
      path = rest[++i];
      if (!path || path.startsWith('--')) { output({ error: 'usage', usage: USAGE }); return 2; }
    }
  }
  try { output(recordFleetAction(verb ?? '', seen.has('--dry-run'), path)); return 0; }
  catch { output({ error: 'invalid-or-unavailable-action', usage: USAGE }); return 2; }
}
