import { listNeedsMason, readNeedsMason } from '../core/fleet/needs-mason-resolve.js';
import { readNeedsMasonReplyDeliveries } from '../core/fleet/needs-mason-relay.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet needs [--json] [--runs-dir DIR]
  --runs-dir DIR  Read DIR/NEEDS-MASON.md (default: ASHLR_RUNS_DIR or ~/.ashlr-runs).
  Also reports needs-you answers whose planner-inbox delivery is unconfirmed
  or unreadable; retry one with: ashlr fleet needs-resolve <nm-id>.`;

export async function cmdFleetNeeds(args: string[], deps: {
  list?: typeof listNeedsMason;
  deliveries?: typeof readNeedsMasonReplyDeliveries;
} = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  let result: ReturnType<typeof readNeedsMason>;
  try {
    result = deps.list ? { status: 'available', items: deps.list({ runsDir }) } : readNeedsMason({ runsDir });
  } catch { result = { status: 'unavailable', items: [] }; }
  const { status, items } = result;
  const replyDeliveries = (deps.deliveries ?? readNeedsMasonReplyDeliveries)({ runsDir });
  if (json) {
    console.log(JSON.stringify({ v: 1, status, count: items.length, items, replyDeliveries }));
    return status === 'unavailable' ? 1 : 0;
  }
  if (status === 'unavailable') {
    process.stderr.write('error: fleet needs unavailable\n');
    return 1;
  }
  const lines: string[] = [];
  if (!items.length) lines.push('Nothing needs Mason.');
  else lines.push(...items.map(item => `${item.id}  ${item.text}`), `${items.length} item(s) need Mason.`, 'Resolve: ashlr fleet needs-resolve <id> --reply "..."');
  if (replyDeliveries.status === 'unavailable') lines.push('Reply delivery status unavailable.');
  else {
    if (replyDeliveries.pending.length > 0) {
      lines.push(`${replyDeliveries.pending.length} needs-you answer(s) are not confirmed in the planner inbox:`);
      for (const entry of replyDeliveries.pending) lines.push(`  ${entry.itemId}  ${entry.text ?? '(ledger text unknown)'}`);
      lines.push('Retry delivery: ashlr fleet needs-resolve <id> (the recorded reply is sent again)');
    }
    if (replyDeliveries.unsafe.length > 0) {
      lines.push(`${replyDeliveries.unsafe.length} delivery receipt(s) are unreadable; inspect the needs-mason-delivery directory.`);
    }
  }
  console.log(scrubSecrets(lines.join('\n')));
  return 0;
}
