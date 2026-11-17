/**
 * `phm fleet asks status` — which of Mason's Nov 4-5 app asks the code on
 * master implements: done, partial, missing or unknown, with evidence paths
 * and one next step each. Read-only; the ask list is
 * src/core/fleet/mason-asks.ts and the judgment is core/fleet/mason-asks-check.ts.
 *
 *   phm fleet asks status              one line per ask
 *   phm fleet asks status --json       fleet.asks.v1
 *   phm fleet asks status --markdown   the table in docs/MASON-ASKS-STATUS.md
 *   --root DIR                         source checkout to read (default: this package)
 */
import { fileURLToPath } from 'node:url';
import { MASON_ASKS } from '../core/fleet/mason-asks.js';
import {
  checkMasonAsks,
  readSourceIndex,
  renderMasonAsksMarkdown,
  renderMasonAsksText,
} from '../core/fleet/mason-asks-check.js';

const USAGE = `Usage: phm fleet asks status [--json | --markdown] [--root DIR]
Show which of Mason's app asks the code implements: done, partial, missing or unknown.`;

/** Package root: src/cli/ and dist/cli/ both sit two levels below it. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function cmdFleetAsks(args: string[], deps: {
  output?: (text: string) => void; error?: (text: string) => void;
} = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => { process.stdout.write(text); });
  const error = deps.error ?? ((text: string) => { process.stderr.write(text); });
  if (args.some(arg => arg === '--help' || arg === '-h')) { output(`${USAGE}\n`); return 0; }
  const [sub, ...rest] = args;
  if (sub !== 'status') { error(`${USAGE}\n`); return 2; }
  let format: 'text' | 'json' | 'markdown' = 'text';
  let root = PACKAGE_ROOT;
  let rootSet = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const next = rest[i + 1];
    if ((arg === '--json' || arg === '--markdown') && format === 'text') format = arg === '--json' ? 'json' : 'markdown';
    else if (arg === '--root' && !rootSet && next && !next.startsWith('-')) { root = next; rootSet = true; i++; }
    else { error(`error: unexpected argument ${arg}\n${USAGE}\n`); return 2; }
  }
  const report = checkMasonAsks(MASON_ASKS, readSourceIndex(root, MASON_ASKS));
  if (format === 'json') output(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === 'markdown') output(renderMasonAsksMarkdown(report, MASON_ASKS));
  else output(renderMasonAsksText(report));
  return 0;
}
