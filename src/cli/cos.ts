import { parseArgs } from 'node:util';
import { cosJobId, cosStatus } from '../core/cos/intake.js';
import { createChannelReceiver, INBOUND_CHANNELS, type InboundChannel } from '../core/fleet/channel-envelope.js';
import { formatChannelAck } from '../core/fleet/channel-ack-text.js';

export async function cmdCos(args: string[]): Promise<number> {
  const json = args.includes('--json');
  try {
    const runsDir = process.env.ASHLR_RUNS_DIR;
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      channel: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      const usage = 'phm cos ask "<text>" --channel <cli|desktop|telegram|email|mobile|page> --json; phm cos status <id> --json';
      console.log(json ? JSON.stringify({ usage }) : usage); return 0;
    }
    const [command, operand] = positionals;
    if (positionals.length !== 2) throw new Error('Expected ask <text> or status <id>');
    if (command === 'status') {
      if (values.channel) throw new Error('--channel is only supported for ask');
      const result = await cosStatus(operand, runsDir);
      console.log(JSON.stringify(result, null, json ? undefined : 2)); return 0;
    }
    if (command !== 'ask' || !INBOUND_CHANNELS.includes(values.channel as InboundChannel)) throw new Error('Ask requires a supported --channel');
    const receive = createChannelReceiver({ allowedSenderIds: new Set(['cos-local']), publish: null, runsDir });
    const result = await receive({ channel: values.channel as InboundChannel, verifiedSenderId: 'cos-local', body: operand });
    if (!result.ok) throw new Error(`Intake refused: ${result.reason}`);
    const response = { id: cosJobId(result.ack.dedupeKey), ack: formatChannelAck(result.ack), status: 'queued' };
    console.log(json ? JSON.stringify(response) : `${response.ack}\nJob: ${response.id}`); return 0;
  } catch {
    const error = 'Chief-of-staff operation failed. Check command, channel, job id and local queue availability.';
    console.log(json ? JSON.stringify({ error }) : error); return 1;
  }
}
