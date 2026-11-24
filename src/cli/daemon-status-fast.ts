import { readFastDaemonStatus } from '../core/daemon/status-fast.js';

export async function cmdDaemonStatusFast(json: boolean): Promise<number> {
  const status = readFastDaemonStatus();
  console.log(json ? JSON.stringify(status) : `Last tick: ${status.lastTickAt ?? 'unknown'}`);
  return 0;
}
