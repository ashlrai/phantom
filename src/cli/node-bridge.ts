/** `phm node bridge [--owner <scope>] [--apply] [--json]`: thin handler over the ready.tsv -> node bridge. */
import type { NodeBridgeReport } from '../core/drive/nodes/ready-bridge.js';

const USAGE = 'Usage: phm node bridge [--owner <scope>] [--apply] [--json]';

/** `$ASHLR_HOME/node-bridge.json` spelled for operators — the real path under
 * a relocated home, contracted to `~` on a default install. The store module
 * loads lazily so --help stays off its graph; the documented spelling is the
 * fallback when resolution itself fails. */
async function bridgeConfigLabel(): Promise<string> {
  try {
    const { ashlrHomePath } = await import('../core/cloud/store.js');
    return ashlrHomePath('node-bridge.json');
  } catch { return '~/.ashlr/node-bridge.json'; }
}

function text(r: NodeBridgeReport): string {
  const head = `node bridge ${r.mode} owner=${r.owner ?? 'unset'} ${r.inert ? `inert: ${r.inert}` : 'active'}${r.held ? ` held: ${r.held}` : ''}`;
  return [head,
    ...r.nodes.map(n => `node ${n.nodeId} caps=${n.caps.join(',') || '-'} free=${n.freeSlots ?? 'unknown'}/${n.slots ?? 'unknown'}`),
    ...r.rows.map(row => `${row.job} ${row.offload ? `-> ${row.nodeId}` : `stays local: ${row.reasons.join(',')}`}`),
    ...r.leases.map(l => `lease ${l.job} ${l.state} router=${l.routerState ?? 'absent'} next=${l.action}`)].join('\n');
}

export async function cmdNodeBridge(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(`${USAGE}\nDry run by default: lists ready.tsv rows that would offload to a node and why each stays local. --apply runs one claim/reconcile pass (needs ${await bridgeConfigLabel()} enabled).\nAll node commands: phm node --help`); return 0; }
  const json = args.includes('--json');
  const ownerAt = args.indexOf('--owner');
  const owner = ownerAt >= 0 ? args[ownerAt + 1] : undefined;
  const known = args.every((a, i) => ['--json', '--apply', '--owner'].includes(a) || (i === ownerAt + 1 && ownerAt >= 0));
  if (!known || (ownerAt >= 0 && (!owner || owner.startsWith('--')))) {
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'bridge', error: { code: 'usage', message: USAGE, fix: 'Run: phm node bridge --help' } }));
    else console.error(USAGE);
    return 2;
  }
  const { runConfiguredNodeBridge } = await import('../core/drive/nodes/ready-bridge-run.js');
  let report: NodeBridgeReport;
  try {
    report = await runConfiguredNodeBridge({ apply: args.includes('--apply'), ...(owner ? { owner } : {}) });
  } catch (error) {
    // Store and privacy messages in this stack are fixed operator-facing
    // strings; anything else stays masked, as in the node fleet verbs.
    const operatorMessage = /^(?:Invalid |Drive |(?:Universe|Private) storage|Unsafe drive|Cannot create filesystem root)/;
    const message = error instanceof Error && operatorMessage.test(error.message)
      ? error.message : 'Node bridge unavailable or misconfigured.';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'bridge',
      error: { code: 'error', message, fix: `Check ${await bridgeConfigLabel()} and the node pool config.` } }));
    else console.error(message);
    return 1;
  }
  console.log(json ? JSON.stringify({ schemaVersion: 1, command: 'bridge', ...report }) : text(report));
  return 0;
}
