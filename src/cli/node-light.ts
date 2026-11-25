import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { nodeErrorEnvelope } from './node-fleet-usage.js';
import { restockLight, runLightJob } from '../core/drive/nodes/light.js';
import { callPool, readPoolConfig } from '../core/drive/nodes/pool-host.js';
import { privateDirectory } from '../core/universe/artifacts.js';
import { writePrivateFileAtomically } from '../core/util/private-file-write.js';

export async function cmdNodeLight(args: string[]): Promise<number> {
  try {
    const [verb, ...flags] = args;
    if (!['restock', 'status', 'run'].includes(verb ?? '') || new Set(flags).size !== flags.length ||
      flags.some(f => f !== '--json' && !(verb === 'restock' && f === '--apply'))) throw new Error('usage');
    if (verb === 'run') console.log(JSON.stringify(await runLightJob(process.stdin)));
    else {
      const config = readPoolConfig();
      if (!config || config.owner !== 'ashlr') throw new Error('pool');
      const report = restockLight((v, a) => {
        const reply = callPool(config, v, a);
        if (reply.demoted) throw new Error('demoted');
        return reply.result;
      }, flags.includes('--apply'));
      if (flags.includes('--apply')) {
        const root = privateDirectory(join(homedir(), '.ashlr-runs', 'metrics', 'muse-light'));
        writePrivateFileAtomically(join(root, `${randomUUID()}.tmp`), join(root, 'status.json'),
          JSON.stringify(report) + '\n', { anchorPath: root, label: 'Muse light metrics' });
      }
      console.log(JSON.stringify(report));
    }
    return 0;
  } catch (error) {
    const usage = error instanceof Error && error.message === 'usage';
    console.log(JSON.stringify(nodeErrorEnvelope('light', usage
      ? { code: 'usage', message: 'Usage: phm node light restock|status|run [--apply on restock] [--json]. run reads one light job on stdin.',
          fix: 'Run: phm node light restock --json, or phm node --help for the command list.' }
      : { code: 'unavailable', message: 'Light operation refused or unavailable; check pool, lease and fixed recipe runner.',
          fix: 'Join the ashlr pool first (phm node join --json), then retry; see docs/nodes/MUSE.md.' })));
    return 1;
  }
}
