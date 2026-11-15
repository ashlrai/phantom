import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
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
  } catch {
    console.log(JSON.stringify({ schema: 'muse.light.v1', error: 'Light operation refused or unavailable; check pool, lease and fixed recipe runner.' }));
    return 1;
  }
}
