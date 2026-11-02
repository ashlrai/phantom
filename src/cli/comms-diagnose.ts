/** Read-only local evidence. Explicit projections prevent identities/config/errors escaping. */
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { readTelegramHealth, telegramEnabled } from '../core/integrations/telegram.js';
import { commsEnabled } from '../core/integrations/imessage.js';
import { listRequests } from '../core/comms/requests.js';
import { inspectBusInbox } from '../core/fleet/bus-inbox.js';
import { readInboxEntries } from '../core/fleet/mason-inbox.js';

type State = 'ok' | 'blocked' | 'unavailable' | 'unsupported';
interface Check { id: string; state: State; reason: string; nextStep: string }

export async function cmdCommsDiagnose(json: boolean): Promise<number> {
  const checks: Check[] = [];
  const add = (id: string, state: State, reason: string, nextStep = 'phm comms diagnose --json'): void => {
    checks.push({ id, state, reason, nextStep });
  };
  let transport: 'telegram' | 'imessage' | 'unsupported' = 'unsupported';
  let enabled: boolean | null = null, configured: boolean | null = null;
  let credential: { present: boolean; source: 'config' | 'environment' | 'missing' } | null = null;
  try {
    const cfg = loadConfigReadOnlyStrict();
    transport = cfg.comms?.channel === 'telegram' ? 'telegram'
      : cfg.comms?.channel === undefined || cfg.comms.channel === 'imessage' ? 'imessage' : 'unsupported';
    enabled = cfg.comms?.enabled === true;
    configured = transport === 'telegram' ? telegramEnabled({ ...cfg, comms: { ...cfg.comms!, enabled: true } })
      : transport === 'imessage' ? Boolean(cfg.comms?.imessageHandle) : false;
    add('transport', enabled && configured ? 'ok' : 'blocked',
      !enabled ? 'transport-disabled' : configured ? 'transport-configured-not-delivery-proof' : 'transport-incomplete');
    if (transport === 'telegram') {
      const health = readTelegramHealth(cfg);
      credential = { present: health.tokenPresent, source: !health.tokenPresent ? 'missing'
        : typeof cfg.comms?.telegram?.botToken === 'string' ? 'config' : 'environment' };
      add('credential', health.tokenPresent ? 'ok' : 'blocked', health.tokenPresent ? 'credential-present' : 'credential-missing');
      add('telegram-poller', !configured ? 'blocked' : health.error ? 'blocked' : health.pollerAlive ? 'ok' : 'blocked',
        !configured ? 'telegram-incomplete' : health.error ? 'telegram-health-error'
          : health.pollerAlive ? 'recent-poll-heartbeat-not-delivery-proof' : 'poller-stale-or-never-polled', 'phm comms health --json');
    } else {
      add('credential', 'unsupported', 'transport-has-no-supported-credential-reader');
      add('poller', 'unsupported', 'transport-has-no-supported-health-reader');
      // commsEnabled includes the platform guard; it is not a send operation.
      if (transport === 'imessage' && !commsEnabled(cfg)) add('imessage-runtime', 'unavailable', 'imessage-runtime-not-ready');
    }
  } catch {
    add('configuration', 'unavailable', 'configuration-unreadable');
  }
  // This established reader silently degrades on I/O errors. Counts are observed,
  // not proof that the store is readable or that the outbound queue is drained.
  const requests = listRequests();
  const pending = requests.filter(row => row?.status === 'pending').length;
  const outstanding = requests.filter(row => row?.status === 'sent' && row.type !== 'report').length;
  add('requests', pending || outstanding ? 'blocked' : 'ok', pending ? 'pending-requests-observed'
    : outstanding ? 'awaiting-reply-observed' : 'no-requests-observed-reader-may-degrade');
  const bus = inspectBusInbox();
  add('local-bus', bus.source === 'available' ? 'ok' : 'unavailable', `bus-source-${bus.source}`, 'phm comms bus status');
  const inbox = await readInboxEntries();
  add('local-receiver', inbox.sourceState === 'healthy' ? 'ok' : 'unavailable',
    `receiver-inbox-source-${inbox.sourceState}`, 'phm comms inbox read --json');
  add('delivery', 'unsupported', 'local-evidence-cannot-verify-end-to-end-delivery');
  const result = { schemaVersion: 1, readOnly: true, transport, enabled, configured, credential,
    requests: { pending, outstanding, availability: 'not-established' }, checks };
  if (json) console.log(JSON.stringify(result));
  else {
    console.log('Channel diagnostics (local evidence only; delivery unverified)');
    for (const check of checks) console.log(`${check.id}: ${check.state} (${check.reason}); next: ${check.nextStep}`);
  }
  return checks.some(check => check.state === 'blocked' || check.state === 'unavailable') ? 1 : 0;
}
