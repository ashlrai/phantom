import type { FleetMemoryResponse } from '../fleet-host/memory-guard-query.js';
import type { FleetStandbyView } from '../fleet-host/standby-card-model.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

/** Read-only host alerts; missing readings never become pressure readings. */
export function deriveHostGuardNeedsYou(
  memory: FleetMemoryResponse | null | undefined,
  standby: FleetStandbyView | null | undefined,
  nowMs: number,
): FleetNeedsYouItem[] {
  // Age is supplied by the memory projection, not inferred from the browser clock.
  void nowMs;
  const items: FleetNeedsYouItem[] = [];
  const add = (id: string, severity: FleetNeedsYouItem['severity'], title: string, detail: string, nextStep: string) => {
    items.push({ id, severity, title, detail, nextStep, target: 'fleet', open: { kind: 'pane', paneId: 'fleet-host' } });
  };
  if (memory) {
    const { sample, memguard } = memory.memory;
    const stopped = memguard.stopped;
    if (Array.isArray(stopped) && stopped.length > 0) {
      add('memory-guard-stopped', 'urgent', `Memory guard stopped ${stopped.length} worker${stopped.length === 1 ? '' : 's'}`,
        [...stopped.slice(0, 5), ...(stopped.length > 5 ? [`+${stopped.length - 5} more`] : [])].join(', '),
        'Workers resume when pressure drops; open Mac host to see the level');
    }
    if (sample.stale === true) {
      add('memory-sample-stale', 'attention', sample.age_ms === null
        ? 'Memory sample is stale (age unknown)' : `Memory sample is ${Math.max(0, Math.floor(sample.age_ms / 60_000))} min old`,
      'The guard may not be running.', 'Check launchd label ai.ashlr.memguard');
    } else if (typeof sample.free_pct === 'number' && Number.isFinite(sample.free_pct) && sample.free_pct < 10) {
      add('memory-low', 'urgent', `Mac memory free ${sample.free_pct}%`, 'The Mac has very little free memory.',
        'Quit an app you are not using, or let the guard pause workers');
    }
  }
  if (standby?.configured) {
    if (!standby.available) {
      add('standby-no-reading', 'attention', 'Second computer: no reading', 'The configured second computer is not reporting.',
        'Open Mac host to check the second computer');
    } else if (!standby.ready) {
      add('standby-not-ready', 'attention', `Second computer cannot take over: ${standby.blocker || 'unknown'}`,
        'The configured second computer is not ready.', 'Open Mac host to check the second computer');
    }
  }
  return items;
}
