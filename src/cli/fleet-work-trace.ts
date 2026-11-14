/** `ashlr fleet work-trace` — turn a bus message id into a RECEIVED /
 * ASSIGNED / RUNNING / BLOCKED / VERIFIED state built from the real durable
 * stores (bus inbox, bus work claims), never a hand-written evidence file.
 * Read-only: no writes, no network; labels and tokens grant no authority. */
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { collectBusWorkItemEvidence } from '../core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../core/comms/work-item-state.js';

const usage = 'Usage: ashlr fleet work-trace --id <bus-message-id> [--root <absolute>] [--json]\n'
  + 'Prints one line: ID STATE as-of=... source=... missing=... inbox=<found|missing|unavailable> claims=<available|missing|unavailable>.\n'
  + 'State comes only from the durable stores; an unknown id is RECEIVED with as-of=unknown. Read-only.';

export async function cmdFleetWorkTrace(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let id: string | undefined, root: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--id' && key !== '--root') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--id' && id === undefined) id = value;
    else if (key === '--root' && root === undefined) root = value;
    else { console.error(usage); return 2; }
  }
  if (!id || (root !== undefined && (!isAbsolute(root) || root.includes('\0')))) { console.error(usage); return 2; }
  const now = Date.now();
  const { evidence, sources } = collectBusWorkItemEvidence(id, { root: root ?? join(ashlrHome(), 'fleet'), now });
  const result = { id, ...classifyWorkItem(evidence, new Date(now).toISOString()), inbox: sources.inbox, claims: sources.claims };
  if (json) console.log(JSON.stringify(result));
  else console.log(`${result.id} ${result.state} as-of=${result.asOf} source=${result.source} `
    + `missing=${result.missing.length ? result.missing.join(',') : 'none'} inbox=${result.inbox} claims=${result.claims}`);
  return 0;
}
