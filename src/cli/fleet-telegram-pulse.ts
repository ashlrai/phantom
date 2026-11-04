import { loadConfig } from '../core/config.js';
import type { AshlrConfig } from '../core/types.js';
import { buildVisibilitySnapshot, type VisibilitySnapshot } from '../core/web/visibility.js';
import { buildFleetPulseMessage, sendFleetPulse } from '../core/comms/fleet-pulse.js';
import { telegramEnabled } from '../core/integrations/telegram.js';

const usage = 'Usage: ashlr fleet telegram-pulse [--json] [--send]';

export async function cmdFleetTelegramPulse(args: string[], opts: {
  loadConfig?: () => AshlrConfig | Promise<AshlrConfig>;
  buildSnapshot?: (cfg: AshlrConfig) => Promise<VisibilitySnapshot>;
  send?: (text: string, cfg: AshlrConfig) => Promise<void>;
} = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  let json = false;
  let send = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else if (arg === '--send' && !send) send = true;
    else { console.error(usage); return 2; }
  }
  try {
    const cfg = await (opts.loadConfig ?? loadConfig)();
    const snap = await (opts.buildSnapshot ?? buildVisibilitySnapshot)(cfg);
    const html = buildFleetPulseMessage(snap, cfg.comms?.timeZone);
    const text = html.replace(/<[^>]*>/g, '').replace(/&(lt|gt|amp|quot);/g,
      entity => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"' })[entity]!);
    const reason = send ? cfg.comms?.proactive !== true ? 'proactive-off'
      : !telegramEnabled(cfg) ? 'telegram-off' : undefined : undefined;
    const sent = send && reason === undefined;
    if (sent) {
      if (opts.send) await opts.send(html, cfg);
      else await sendFleetPulse(snap, cfg);
    }
    console.log(json ? JSON.stringify({ mode: send ? 'send' : 'dry-run', text, sent, ...(reason ? { reason } : {}) })
      : reason ? `Fleet pulse not sent: ${reason}.` : text);
    return 0;
  } catch {
    console.error('Unable to build fleet pulse.');
    return 1;
  }
}
