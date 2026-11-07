/**
 * `ashlr fleet cos-reconcile` — Mason records what he found after an uncertain
 * chief-of-staff send. Sends nothing; `--retry` only allows one more approval.
 */
import { reconcileCosDelivery } from '../core/cos/reconcile.js';

const usage = `Usage: ashlr fleet cos-reconcile <id> (--delivered|--retry) [--json]
Settle a chief-of-staff reply whose send is uncertain (or crashed mid-send).
--delivered  you saw it arrive: mark it sent and close its NEEDS-MASON line
--retry      it did not arrive: allow one more explicitly approved send
Sends nothing. Exit 0 on success, 1 for a refused state, 2 for usage errors.`;

export async function cmdFleetCosReconcile(args: string[]): Promise<number> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) { console.log(json ? JSON.stringify({ usage }) : usage); return 0; }
  const verdicts = args.filter(arg => arg === '--delivered' || arg === '--retry');
  const rest = args.filter(arg => arg !== '--json' && arg !== '--delivered' && arg !== '--retry');
  const [id] = rest;
  if (verdicts.length !== 1 || rest.length !== 1 || id!.startsWith('-')) {
    console.error(`Invalid arguments. ${usage.split('\n')[0]}`);
    return 2;
  }
  try {
    const result = await reconcileCosDelivery(id!, verdicts[0] === '--delivered' ? 'delivered' : 'retry');
    console.log(json ? JSON.stringify(result) : `${result.id}: ${result.from} -> ${result.to}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cos-reconcile failed';
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  }
}
