export type FleetPresence = 'present' | 'missing' | 'unknown';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readFleetPresence(snapshot: unknown): FleetPresence {
  if (!record(snapshot) || !record(snapshot.sources)) return 'unknown';
  switch (snapshot.sources.runsDir) {
    case 'healthy':
    case 'degraded': return 'present';
    case 'missing': return 'missing';
    default: return 'unknown';
  }
}

export function whatsNewCopy(presence: FleetPresence): {
  bullets: string[];
  primary: { label: string; action: 'fleet-workspace' | 'fleet-sources' | 'settings' };
} {
  if (presence === 'present') return {
    bullets: [
      'Open Lanes, Merges and Queue as dock panes with /pane.',
      'The Inbox pane sends messages to MASON-INBOX.md.',
      'The notification bell shows fleet, merge and update alerts.',
      'Pair a device to use the mobile remote at /verse/m/.',
    ],
    primary: { label: 'Open fleet workspace', action: 'fleet-workspace' },
  };
  return {
    bullets: [
      'Open dock panes with /pane; ⌘/ lists keyboard shortcuts.',
      'The notification bell shows fleet, merge and update alerts.',
      'Pair a device to use the mobile remote at /verse/m/.',
      'Update now in Settings ▸ Desktop',
    ],
    primary: presence === 'missing'
      ? { label: 'Open Settings ▸ Fleet sources', action: 'fleet-sources' }
      : { label: 'Open Settings', action: 'settings' },
  };
}
