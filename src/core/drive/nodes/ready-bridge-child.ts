/** Daemon `node-bridge` phase child: one apply pass, then a bounded JSON summary on stdout.
 * The daemon spawns this file by path instead of importing it, so the bridge and the node
 * router stay out of the daemon's Tier-1 import closure (same pattern as the resolution observer). */
import { runConfiguredNodeBridge } from './ready-bridge-run.js';
import { createBridgeReceipts } from './ready-bridge-receipts.js';

const controller = new AbortController();
const receipts = createBridgeReceipts(process.ppid);
process.once('SIGTERM', () => {
  receipts.finish();
  controller.abort(new Error('node-bridge phase aborted'));
});
try {
  const report = await runConfiguredNodeBridge({ apply: true, signal: controller.signal, trace: receipts.trace });
  process.stdout.write(JSON.stringify({
    inert: report.inert, held: report.held, rows: report.rows.length,
    offloadable: report.rows.filter(row => row.offload).length,
    claimed: report.claimed, requeued: report.requeued, completed: report.completed,
  }));
} catch {
  process.exitCode = 1;
} finally {
  receipts.finish();
}
