/** `ashlr fleet receipt list | show <run> | verify <run> | status [--json]` (receipt.v1 slice R4). */
import { listReceiptRunIds, readReceiptV1, receiptStatus } from '../core/receipt/receipt-store.js';
import { buildReceiptTimeline, formatReceiptTimeline } from '../core/receipt/receipt-timeline.js';

const USAGE = 'usage: ashlr fleet receipt <list|show <run-id>|verify <run-id>|timeline <run-id>|status> [--json]';

export async function cmdFleetReceipt(args: string[]): Promise<number> {
  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) { process.stdout.write(`${USAGE}\n`); return 0; }
  const json = args.includes('--json');
  const [sub, runId] = args.filter((a) => a !== '--json');
  const out = (v: unknown, text: string): void => { process.stdout.write(json ? `${JSON.stringify(v)}\n` : `${text}\n`); };
  switch (sub) {
    case 'list': {
      const ids = listReceiptRunIds();
      out({ receipts: ids }, ids.length ? ids.join('\n') : 'no receipts');
      return 0;
    }
    case 'status': {
      const s = receiptStatus();
      const latest = s.latest ? `${s.latest.runId} ${s.latest.verified ? 'verified' : `NOT verified (${s.latest.reason})`}` : 'none';
      out(s, `receipt key: ${s.keyPresent ? s.keyId?.slice(0, 12) : 'absent'}\nreceipts: ${s.receipts}\nlatest: ${latest}`);
      return s.latest && !s.latest.verified ? 1 : 0;
    }
    case 'timeline': {
      if (!runId) { process.stderr.write(`${USAGE}\n`); return 2; }
      const t = buildReceiptTimeline(runId);
      out(t, formatReceiptTimeline(t));
      return t.found && t.verified ? 0 : 1;
    }
    case 'show':
    case 'verify': {
      if (!runId) { process.stderr.write(`${USAGE}\n`); return 2; }
      const r = readReceiptV1(runId);
      if (!r.ok) {
        out({ runId, verified: false, reason: r.reason }, `receipt ${runId}: NOT verified (${r.reason})`);
        return 1;
      }
      const later = r.later ?? [];
      if (sub === 'verify') out({ runId, verified: true, digest: r.digest, keyId: r.receipt.sig.key_id, later: later.length }, `receipt ${runId}: verified (digest ${r.digest.slice(0, 12)}, key ${r.receipt.sig.key_id.slice(0, 12)}, ${later.length} later)`);
      else {
        // Signed body as stored (its own later stays []), with the separately signed, chain-verified entries alongside.
        const shown = { ...r.receipt, later };
        out(shown, JSON.stringify(shown, null, 2));
      }
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}
