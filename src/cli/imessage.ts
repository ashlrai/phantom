/**
 * `phm imessage doctor|poll`: iMessage intake readiness and a counts-only poll.
 * Thin: parse argv, delegate to core. Output never contains message text or handles.
 */
import { parseArgs } from 'node:util';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { buildDoctorReport, pollInboundSince, readCursor } from '../core/integrations/imessage.js';
import { ingestIMessages } from '../core/comms/imessage-inbox-bridge.js';
import type { AshlrConfig } from '../core/types.js';

const USAGE = 'phm imessage doctor [--json]; phm imessage poll [--apply] [--json]';

function loadCfg(): AshlrConfig | null {
  try { return loadConfigReadOnlyStrict(); } catch { return null; }
}

export async function cmdIMessage(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const out = (value: object, text: string): void => console.log(json ? JSON.stringify(value) : text);
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      json: { type: 'boolean' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    const [command] = positionals;
    if (values.help || !command || positionals.length !== 1) {
      out({ usage: USAGE }, USAGE);
      return values.help ? 0 : 1;
    }
    const cfg = loadCfg();

    if (command === 'doctor') {
      if (values.apply) throw new Error('--apply is only supported for poll');
      const report = await buildDoctorReport({ cfg });
      out(report, ['iMessage intake (local evidence only)', ...report.checks.map((c) =>
        `${c.id}: ${c.state} (${c.detail})${c.state === 'ok' || c.state === 'set' || c.state === 'info' ? '' : `\n  fix: ${c.fixHint}`}`)].join('\n'));
      return report.ok ? 0 : 1;
    }

    if (command === 'poll') {
      if (!cfg) throw new Error('config unreadable');
      if (values.apply) {
        const r = await ingestIMessages(cfg);
        out({ dryRun: false, ...r }, `iMessage poll: ${r.state}; scanned ${r.scanned}, accepted ${r.accepted}, duplicate ${r.duplicate}, refused ${r.refused}${r.deferred ? ', deferred' : ''}`);
        return r.ok ? 0 : 1;
      }
      // Dry run: read only, cursor untouched, counts only.
      const cursor = readCursor();
      if (cursor === null) {
        out({ dryRun: true, state: 'no-cursor', waiting: 0, cursor: null }, 'iMessage poll (dry run): no cursor yet; --apply baselines to the newest message without ingesting history');
        return 0;
      }
      const polled = await pollInboundSince(cursor, cfg);
      if (!polled.ok) {
        out({ dryRun: true, state: polled.state, waiting: 0, cursor }, `iMessage poll (dry run): ${polled.state}`);
        return 1;
      }
      out({ dryRun: true, state: 'ok', waiting: polled.messages.length, cursor }, `iMessage poll (dry run): ${polled.messages.length} allowlisted message(s) waiting`);
      return 0;
    }
    throw new Error('unknown command');
  } catch {
    const error = `Usage: ${USAGE}`;
    out({ error }, error);
    return 1;
  }
}
