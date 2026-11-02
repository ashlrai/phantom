import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from '../core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { type GuardianDrainDeps } from '../core/fleet/guardian-retry-drain.js';
import { cmdFleetGuardianDrain } from './fleet-guardian-drain.js';

type DrainDeps = GuardianDrainDeps & { now?: () => number; writeLine?: (line: string) => void | Promise<void> };
type BusDeps = DrainDeps & {
  drain?: typeof cmdFleetGuardianDrain;
  append?: (envelope: unknown, options: BusInboxOptions) => BusInboxPost | Promise<BusInboxPost>;
};

/** Route sanitized drain observations to the shared inbox. Routing labels are not authority. */
export async function cmdFleetGuardianBus(args: string[], deps: BusDeps = {}): Promise<number> {
  const values: Record<string, string> = {};
  const forwarded: string[] = [];
  const flags = ['--bus-from', '--bus-to', '--bus-run-id', '--bus-runs-dir'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags.includes(arg)) {
      const value = args[i + 1];
      if (values[arg] !== undefined || !value || value.startsWith('--')) {
        process.stderr.write('error: invalid guardian-bus arguments\n'); return 2;
      }
      values[arg] = value; i++; continue;
    }
    if (arg.startsWith('--bus-')) { process.stderr.write('error: invalid guardian-bus arguments\n'); return 2; }
    forwarded.push(arg);
  }
  const from = values['--bus-from'], to = values['--bus-to'], run = values['--bus-run-id'];
  const token = (value: string | undefined): value is string =>
    value !== undefined && value.length <= 128 && /^[\x21-\x7e]+(?![\s\S])/.test(value);
  const root = values['--bus-runs-dir'];
  if (!token(from) || !token(to) || !token(run) ||
    (root !== undefined && (!isAbsolute(root) || root.length > 4096 || root.includes('\0')))) {
    process.stderr.write('error: invalid guardian-bus arguments\n'); return 2;
  }
  if (!forwarded.includes('--stream')) forwarded.push('--stream');
  const apply = forwarded.includes('--apply');
  let sequence = 0, failed = false;
  const { drain = cmdFleetGuardianDrain, append = appendBusInbox, writeLine, ...drainDeps } = deps;
  return drain(forwarded, { ...drainDeps, writeLine: async line => {
    if (writeLine) await writeLine(line);
    else await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, error => error ? reject(error) : resolve());
    });
    if (!apply || failed) return;
    const record = JSON.parse(line) as Record<string, unknown>;
    const kind = record.record;
    if (kind !== 'attempt' && kind !== 'summary') throw new Error('Invalid guardian observation');
    sequence++;
    const id = `guardian-${createHash('sha256').update(JSON.stringify([run, kind, sequence])).digest('hex')}`;
    const body = kind === 'attempt'
      ? { schema: 'guardian-drain.v1', record: kind, sequence, outcome: record.outcome }
      : { schema: 'guardian-drain.v1', record: kind, sequence, termination: record.termination,
        attempts: record.attempts, verified: record.verified, refused: record.refused };
    const checked = validateBusEnvelope({ id, from, to, priority: 'P2', ttl: 86400000, body });
    if (!checked.ok) { failed = true; throw new Error('Invalid guardian observation'); }
    try {
      const result = await append(checked.value, root === undefined ? {} : { root });
      if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('Inbox refused observation');
    } catch { failed = true; throw new Error('Inbox refused observation'); }
  } });
}
