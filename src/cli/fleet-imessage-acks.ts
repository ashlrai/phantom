import { readImessageAckEvidence } from '../core/comms/imessage-ack-evidence.js';

const USAGE = 'Usage: phm fleet imessage-acks [--limit N] [--json]';
export interface FleetImessageAcksDeps {
  runsDir?: string;
  output?: (line: string) => void;
  error?: (line: string) => void;
}

export async function cmdFleetImessageAcks(args: string[], deps: FleetImessageAcksDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  let limit = 20;
  let json = false;
  let seenLimit = false;
  let rowid: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--limit' && !seenLimit) {
      seenLimit = true;
      const value = args[++i];
      if (!value || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) { error(USAGE); return 2; }
      limit = Number(value);
    } else if (args[i] === '--rowid' && rowid === undefined) {
      const value = args[++i];
      if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) { error(`${USAGE} [--rowid N]`); return 2; }
      rowid = Number(value);
    } else { error(args.includes('--rowid') ? `${USAGE} [--rowid N]` : USAGE); return 2; }
  }
  const report = await readImessageAckEvidence(limit, deps.runsDir, rowid);
  if (json) output(JSON.stringify(report));
  else {
    output(`iMessage acknowledgement source: ${report.sourceState}; malformed rows: ${report.malformedRows}`);
    if (rowid !== undefined) {
      if (report.match === 'unknown') output(`Cannot check rowid ${rowid}: acknowledgement source is ${report.sourceState}.`);
      else if (report.match === 'no-match') output(`No matching acknowledgement for rowid ${rowid} in the bounded tail; ingestion may have occurred outside it.`);
      else output(`Matching acknowledgement recorded for rowid ${rowid}.`);
    }
    for (const row of report.rows) output(`${row.timestamp} rowid ${row.rowid} ${row.status} ${row.delivery}`);
    output('Recorded-not-sent does not establish delivery. Delivery proof: false.');
  }
  return 0;
}
