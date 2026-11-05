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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--limit' && !seenLimit) {
      seenLimit = true;
      const value = args[++i];
      if (!value || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) { error(USAGE); return 2; }
      limit = Number(value);
    } else { error(USAGE); return 2; }
  }
  const report = await readImessageAckEvidence(limit, deps.runsDir);
  if (json) output(JSON.stringify(report));
  else {
    output(`iMessage acknowledgement source: ${report.sourceState}; malformed rows: ${report.malformedRows}`);
    for (const row of report.rows) output(`${row.timestamp} rowid ${row.rowid} ${row.status} ${row.delivery}`);
    output('Recorded-not-sent does not establish delivery. Delivery proof: false.');
  }
  return 0;
}
