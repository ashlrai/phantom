import { loadConfig } from '../core/config.js';
import { createDaemonCapacityPublisher, defaultDaemonCapacityPublisherDeps } from '../core/daemon/capacity-publisher.js';

const HELP = 'Usage: phm capacity publish [--json]';

export async function cmdCapacity(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(HELP);
    return 0;
  }
  const json = args.includes('--json');
  if (args[0] !== 'publish' || args.slice(1).some(a => a !== '--json') || args.length > 2) {
    console.error(json ? JSON.stringify({ error: HELP }) : HELP);
    return 2;
  }
  try {
    const publisher = createDaemonCapacityPublisher(loadConfig(), {
      ...defaultDaemonCapacityPublisherDeps(), log: () => {},
    });
    try {
      const status = await publisher.cycle();
      console.log(json ? JSON.stringify(status) : `${status.state}: ${status.reason}`);
      return ['published', 'published-shared', 'fresh', 'dormant'].includes(status.state) ? 0 : 1;
    } finally {
      publisher.stop();
    }
  } catch {
    const error = 'Capacity publish failed; check local Phantom configuration and directory access, then retry phm capacity publish.';
    console.error(json ? JSON.stringify({ error }) : error);
    return 2;
  }
}
