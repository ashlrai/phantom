import { listNeedsMason, readNeedsMason } from '../core/fleet/needs-mason-resolve.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet needs [--json] [--runs-dir DIR]
  --runs-dir DIR  Read DIR/NEEDS-MASON.md (default: ASHLR_RUNS_DIR or ~/.ashlr-runs).`;

export async function cmdFleetNeeds(args: string[], deps: { list?: typeof listNeedsMason } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  let result: ReturnType<typeof readNeedsMason>;
  try {
    result = deps.list ? { status: 'available', items: deps.list({ runsDir }) } : readNeedsMason({ runsDir });
  } catch { result = { status: 'unavailable', items: [] }; }
  const { status, items } = result;
  if (json) console.log(JSON.stringify({ v: 1, status, count: items.length, items }));
  else if (status === 'unavailable') process.stderr.write('error: fleet needs unavailable\n');
  else if (!items.length) console.log('Nothing needs Mason.');
  else console.log(scrubSecrets([...items.map(item => `${item.id}  ${item.text}`), `${items.length} item(s) need Mason.`, 'Resolve: ashlr fleet needs-resolve <id> --reply "..."'].join('\n')));
  return status === 'unavailable' ? 1 : 0;
}
