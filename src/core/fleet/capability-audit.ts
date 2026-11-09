/**
 * Human-parity capability audit (RQ-SWE5-CAPABILITY-AUDIT).
 *
 * One ranked catalog of what a human can do on this Mac versus what fleet
 * agents can do today through Phantom's desktop control, tool mesh and
 * computer-use surfaces. Read-only: the audit grants no authority and starts
 * no process. Gaps that need Security review of a send/exec path stay listed
 * as deferred; GATES v3 items (secrets, TCC automation, workflow widen,
 * ~/.codex auth) are never proposed as implementation work here.
 */
export const CAPABILITY_AUDIT_SCHEMA = 'capability-audit.v1';

export type CapabilityDomain =
  | 'apps'
  | 'browser'
  | 'files'
  | 'shell'
  | 'gui'
  | 'comms'
  | 'tool-mesh'
  | 'computer-use';

export type CapabilityStatus =
  | 'parity'
  | 'partial'
  | 'gap'
  | 'deferred'
  | 'gates-held';

export type GapLeverage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface CapabilitySurface {
  id: string;
  domain: CapabilityDomain;
  human: string;
  agent: string;
  status: CapabilityStatus;
  /** Higher = close this first among implementable gaps. Null when not a gap to close here. */
  leverage: GapLeverage | null;
  route: string;
  gatesSafe: boolean;
  notes: string;
}

/** Fixed inventory: human Mac actions vs the current agent-reachable surface. */
export const CAPABILITY_SURFACES: readonly CapabilitySurface[] = [
  {
    id: 'apps-list-status-quit',
    domain: 'apps',
    human: 'See which apps are running, bring them forward, quit them.',
    agent: 'phm apps list|status|quit on allowlisted apps via computer_*; quit routes unsaved work to needs-you.',
    status: 'partial',
    leverage: null,
    route: 'phm apps list|status|quit --json',
    gatesSafe: true,
    notes: 'Needs a Phantom desktop chat connection; allowlist empty by default.',
  },
  {
    id: 'apps-open-focus',
    domain: 'apps',
    human: 'Open or raise any installed app from Spotlight / Dock / open(1).',
    agent: 'phm apps open|focus on allowlisted apps through an AppLauncher (host /usr/bin/open -b on macOS).',
    status: 'partial',
    leverage: 10,
    route: 'phm apps open|focus --json',
    gatesSafe: true,
    notes: 'Still allowlisted, feed-logged and denylist-bound; no TCC change. Bundle id required to start a not-running app.',
  },
  {
    id: 'desktopctl-task-apps',
    domain: 'computer-use',
    human: 'Drive Claude / Codex / Devin desktop apps by hand.',
    agent: 'phm desktopctl status|run for claude|codex|devin when ~/.ashlr/desktopctl.json enables it.',
    status: 'partial',
    leverage: null,
    route: 'phm desktopctl capabilities|status|run --json',
    gatesSafe: true,
    notes: 'Flag-gated; reports missing TCC grants, never prompts; screen text untrusted.',
  },
  {
    id: 'desktopctl-browser-run',
    domain: 'browser',
    human: 'Click and type in any browser window.',
    agent: 'desktopctl run browser is refused (read-only-resource); act via Phantom Browser pane browser_* tools.',
    status: 'gap',
    leverage: 8,
    route: 'Verse browser_* MCP / Phantom Browser pane',
    gatesSafe: true,
    notes: 'Fleet shells without a Verse seat cannot drive the web; closing this needs a logged browser bridge, not desktopctl run.',
  },
  {
    id: 'computer-use-tools',
    domain: 'computer-use',
    human: 'See the screen, click, type, scroll in granted apps.',
    agent: 'computer_* tools (permissions, list_apps, screenshot, ax_*, click, type, key, scroll, drag) under per-chat grant and ceilings.',
    status: 'partial',
    leverage: null,
    route: 'ashlr-hub MCP computer_*',
    gatesSafe: true,
    notes: 'Browsers ceiling read-only; terminals/editors click-only; secure fields refused; denylist includes Phantom and password managers.',
  },
  {
    id: 'files-worktree',
    domain: 'files',
    human: 'Read and write any file the account can touch.',
    agent: 'Worktree-scoped read/write/edit in sandboxed runs; Universe file-ops in declared trees.',
    status: 'partial',
    leverage: null,
    route: 'sandboxed run / Universe file-ops',
    gatesSafe: true,
    notes: 'Arbitrary home-directory writes stay out of scope on purpose.',
  },
  {
    id: 'shell-host',
    domain: 'shell',
    human: 'Run any shell command in Terminal.',
    agent: 'Sandboxed fleet shell; companion ashlr__bash when wired; agent Terminal pane history is read-only.',
    status: 'partial',
    leverage: null,
    route: 'sandboxed run / MCP bash',
    gatesSafe: true,
    notes: 'Unconfined host shell for agents would bypass sandbox profiles (GATES).',
  },
  {
    id: 'gui-tcc-grants',
    domain: 'gui',
    human: 'Approve Screen Recording / Accessibility in System Settings.',
    agent: 'Reports grant state via computer_permissions; never prompts or changes TCC.',
    status: 'gates-held',
    leverage: null,
    route: 'phm desktopctl capabilities --json',
    gatesSafe: false,
    notes: 'MACCU TCC helper and grant UX stay operator-only under GATES v3.',
  },
  {
    id: 'comms-drafts-send',
    domain: 'comms',
    human: 'Send email to anyone after composing it.',
    agent: 'phm drafts approve records a decision and does not send; outbound needs a reviewed sender.',
    status: 'deferred',
    leverage: 7,
    route: 'phm drafts list|show|approve|reject --json',
    gatesSafe: false,
    notes: 'Approve≠send by design until a Security-reviewed send path lands.',
  },
  {
    id: 'comms-imessage-ack',
    domain: 'comms',
    human: 'Reply on iMessage.',
    agent: 'Intake works; owner acks are recorded not sent until RQ-IMSG-REPLY-1; teammate respond --apply is local-only.',
    status: 'deferred',
    leverage: 6,
    route: 'phm imessage doctor|poll|respond --json',
    gatesSafe: false,
    notes: 'Send path needs the separately reviewed reply change.',
  },
  {
    id: 'tool-mesh-inventory',
    domain: 'tool-mesh',
    human: 'See which CLIs and MCP tools are installed and callable.',
    agent: 'phm connectors mesh --json inventories native tools and connector availability (PATH only).',
    status: 'partial',
    leverage: null,
    route: 'phm connectors mesh --json',
    gatesSafe: true,
    notes: 'Mesh is discovery; connectors run stays denied pending Security review. Further mesh expansion is a separate RQ.',
  },
  {
    id: 'tool-mesh-run',
    domain: 'tool-mesh',
    human: 'Run gh, cloud CLIs, etc. with signed-in credentials.',
    agent: 'phm connectors run is denied pending Security review; no process, no credential resolution.',
    status: 'deferred',
    leverage: 5,
    route: 'phm connectors run (denied)',
    gatesSafe: false,
    notes: 'RQ-COS-CONNRUN-1-sec; vault names only once reviewed.',
  },
  {
    id: 'browser-task-apply',
    domain: 'browser',
    human: 'Open a URL or path immediately.',
    agent: 'ashlr_browser_task / ashlr_desktop_open propose into the inbox; headless apply is refused.',
    status: 'gap',
    leverage: 4,
    route: 'ashlr-hub MCP ashlr_browser_task|ashlr_desktop_open',
    gatesSafe: true,
    notes: 'Closing apply when a desktop chat is connected recovers open-this without new privileges.',
  },
  {
    id: 'apps-keystrokes',
    domain: 'apps',
    human: 'Type into any focused app.',
    agent: 'phm apps never types; computer_type / desktopctl run do under full grant.',
    status: 'parity',
    leverage: null,
    route: 'computer_type / phm desktopctl run',
    gatesSafe: true,
    notes: 'Apps control stays lifecycle-only on purpose; driving is desktopctl/computer-use.',
  },
] as const;

export interface CapabilityGap {
  id: string;
  domain: CapabilityDomain;
  leverage: GapLeverage;
  status: CapabilityStatus;
  gatesSafe: boolean;
  summary: string;
  route: string;
  implementNow: boolean;
}

export interface CapabilityAuditReport {
  schema: typeof CAPABILITY_AUDIT_SCHEMA;
  generatedAt: string;
  surfaces: CapabilitySurface[];
  /** Gaps and deferred items, highest leverage first; gates-held excluded. */
  gaps: CapabilityGap[];
  /** Subset of gaps that are GATES-safe to implement without a Security send/exec review. */
  implementableNow: CapabilityGap[];
  counts: {
    surfaces: number;
    parity: number;
    partial: number;
    gap: number;
    deferred: number;
    gatesHeld: number;
    implementableNow: number;
  };
}

function toGap(surface: CapabilitySurface): CapabilityGap | null {
  if (surface.leverage === null) return null;
  if (surface.status === 'parity' || surface.status === 'gates-held') return null;
  return {
    id: surface.id,
    domain: surface.domain,
    leverage: surface.leverage,
    status: surface.status,
    gatesSafe: surface.gatesSafe,
    summary: `${surface.human} → ${surface.agent}`,
    route: surface.route,
    implementNow: surface.gatesSafe && (surface.status === 'gap' || surface.status === 'partial'),
  };
}

/** Build the audit report. Pure; `now` is injectable for hermetic tests. */
export function buildCapabilityAudit(now = new Date()): CapabilityAuditReport {
  const surfaces = CAPABILITY_SURFACES.map((s) => ({ ...s }));
  const gaps = surfaces
    .map(toGap)
    .filter((g): g is CapabilityGap => g !== null)
    .sort((a, b) => b.leverage - a.leverage || a.id.localeCompare(b.id));
  const implementableNow = gaps.filter((g) => g.implementNow);
  const count = (status: CapabilityStatus): number => surfaces.filter((s) => s.status === status).length;
  return {
    schema: CAPABILITY_AUDIT_SCHEMA,
    generatedAt: now.toISOString(),
    surfaces,
    gaps,
    implementableNow,
    counts: {
      surfaces: surfaces.length,
      parity: count('parity'),
      partial: count('partial'),
      gap: count('gap'),
      deferred: count('deferred'),
      gatesHeld: count('gates-held'),
      implementableNow: implementableNow.length,
    },
  };
}

/** Plain-text summary for operators. */
export function formatCapabilityAudit(report: CapabilityAuditReport): string {
  const lines = [
    `Capability audit (${report.schema})`,
    `surfaces=${report.counts.surfaces} parity=${report.counts.parity} partial=${report.counts.partial} gap=${report.counts.gap} deferred=${report.counts.deferred} gates-held=${report.counts.gatesHeld}`,
    `implementable-now=${report.counts.implementableNow} (GATES-safe gaps/partials ranked by leverage)`,
    '',
    'Ranked gaps:',
  ];
  for (const gap of report.gaps) {
    const tag = gap.implementNow ? 'NOW' : gap.gatesSafe ? 'safe' : 'held';
    lines.push(`  L${gap.leverage} [${tag}] ${gap.id} (${gap.domain}): ${gap.route}`);
  }
  return lines.join('\n');
}
