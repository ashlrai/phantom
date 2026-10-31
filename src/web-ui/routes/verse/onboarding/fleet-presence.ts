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
      'Fleet workspace: live jobs, lanes and merges from this Mac',
      "Leaders' inbox: your prompts land in MASON-INBOX.md",
      'Ops tray: queue, releases and lane targets',
    ],
    primary: { label: 'Open fleet workspace', action: 'fleet-workspace' },
  };
  return {
    bullets: [
      'Ops tray: queue, releases and lane targets when available',
      'Update now in Settings ▸ Desktop',
      '⌘/ opens keyboard shortcuts',
    ],
    primary: presence === 'missing'
      ? { label: 'Open Settings ▸ Fleet sources', action: 'fleet-sources' }
      : { label: 'Open Settings', action: 'settings' },
  };
}
