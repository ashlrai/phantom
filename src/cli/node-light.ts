import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { restockLight, runLightJob } from '../core/drive/nodes/light.js';
import { callPool, readPoolConfig, type PoolConfig } from '../core/drive/nodes/pool-host.js';
import { privateDirectory } from '../core/universe/artifacts.js';
import { writePrivateFileAtomically } from '../core/util/private-file-write.js';

const USAGE = 'Usage: phm node light <restock|status|run> [--apply] [--json]';

export interface NodeLightDeps {
  readConfig?: () => PoolConfig | null;
  /** The pool read behind restock/status; the default wires callPool to the config. */
  restock?: (apply: boolean) => ReturnType<typeof restockLight>;
  runJob?: (input: AsyncIterable<Buffer | string>) => Promise<unknown>;
  stdin?: AsyncIterable<Buffer | string>;
  writeStatus?: (report: ReturnType<typeof restockLight>) => void;
}

function writeLightStatus(report: ReturnType<typeof restockLight>): void {
  const root = privateDirectory(join(homedir(), '.ashlr-runs', 'metrics', 'muse-light'));
  writePrivateFileAtomically(join(root, `${randomUUID()}.tmp`), join(root, 'status.json'),
    JSON.stringify(report) + '\n', { anchorPath: root, label: 'Muse light metrics' });
}

/** `run` reads one job request on stdin and never touches the pool; only
 * `restock`/`status` need this computer's node-pool config. Each refusal names
 * its own precondition instead of blaming pool, lease and runner for every
 * failure — including argument mistakes, which are usage errors (exit 2). */
export async function cmdNodeLight(args: string[], deps: NodeLightDeps = {}): Promise<number> {
  const refuse = (error: string, exit: number): number => {
    console.log(JSON.stringify({ schema: 'muse.light.v1', error }));
    return exit;
  };
  const [verb, ...flags] = args;
  if (!['restock', 'status', 'run'].includes(verb ?? '') || new Set(flags).size !== flags.length ||
    flags.some(f => f !== '--json' && !(verb === 'restock' && f === '--apply'))) {
    return refuse(`Invalid light command. ${USAGE}`, 2);
  }
  if (verb === 'run') {
    try {
      console.log(JSON.stringify(await (deps.runJob ?? runLightJob)(deps.stdin ?? process.stdin)));
      return 0;
    } catch {
      return refuse('Light job refused: stdin was not a supported muse-light request, or its fixed recipe check failed.', 1);
    }
  }
  let config: PoolConfig | null;
  try { config = (deps.readConfig ?? readPoolConfig)(); }
  catch { return refuse('Node pool config is present but unreadable; light mode cannot verify it.', 1); }
  if (!config) {
    return refuse('No node pool is configured on this computer. Light mode is the muse pool\'s isolated slice and runs only inside that pool, so this computer needs pool enrollment first (see docs/NODES.md).', 1);
  }
  if (config.owner !== 'ashlr') {
    return refuse(`This computer's node pool is owned by '${config.owner}'; light recipes are the 'ashlr' muse slice only.`, 1);
  }
  const apply = flags.includes('--apply');
  const pool = config;
  const restock = deps.restock ?? ((doApply: boolean) => restockLight((v, a) => {
    const reply = callPool(pool, v, a);
    if (reply.demoted) throw new Error('demoted');
    return reply.result;
  }, doApply));
  let report: ReturnType<typeof restockLight>;
  try {
    report = restock(apply);
  } catch {
    return refuse('Light pool operation refused or unavailable; the configured pool may be unreachable or demoted.', 1);
  }
  if (apply) {
    try {
      (deps.writeStatus ?? writeLightStatus)(report);
    } catch {
      return refuse('Light report computed but could not be written to the private metrics file.', 1);
    }
  }
  console.log(JSON.stringify(report));
  return 0;
}
