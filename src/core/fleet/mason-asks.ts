/**
 * Mason's Nov 4-5 product asks for the desktop app and phone view, as data.
 *
 * Each ask lists the pieces that must exist for it to count as done. A piece
 * names a repo-relative file reachable from the app (a registered pane, a
 * Settings panel, a phone screen) or a CLI verb file, and optionally an
 * export that file must carry. A piece with no `path` is a known gap: nothing
 * on master builds it yet, so the ask cannot read done until someone adds a
 * path here alongside the code. mason-asks-check.ts judges the state.
 */

export interface MasonAskPiece {
  /** Plain words for the piece, used in the next step ("Build <need>."). */
  need: string;
  /** Repo-relative path; absent means no code on master builds this yet. */
  path?: string;
  /** Export name the file must carry for the piece to count. */
  exportName?: string;
}

export interface MasonAsk {
  id: string;
  title: string;
  ask: string;
  pieces: readonly MasonAskPiece[];
}

const VERSE = 'src/web-ui/routes/verse';

export const MASON_ASKS: readonly MasonAsk[] = [
  {
    id: 'A1',
    title: 'Visibility map',
    ask: 'Live 2D and 3D map of all sessions and agents, grouped by org structure, agent-to-agent messages visible, provider logos on connections.',
    pieces: [
      { need: 'the 2D and 3D compute map pane', path: `${VERSE}/company/compute.pane.tsx` },
      { need: 'the 2D map view', path: `${VERSE}/company/ComputeMap.tsx`, exportName: 'ComputeMap' },
      { need: 'the 3D map view', path: `${VERSE}/company/ComputeScene3D.tsx`, exportName: 'ComputeScene3D' },
      { need: 'org grouping on the map', path: `${VERSE}/fleet/org-map-query.ts`, exportName: 'fleetOrgMapQuery' },
      { need: 'agent-to-agent messages on the map', path: `${VERSE}/fleet-bus/agent-bus-queries.ts`, exportName: 'getLatestAgentBusPage' },
      { need: 'the fleet map CLI verb', path: 'src/cli/fleet-map.ts', exportName: 'cmdFleetMap' },
      { need: 'provider logos on map connections' },
    ],
  },
  {
    id: 'A2',
    title: 'Panels',
    ask: 'Polished panels for messaging channels, connectors, plugins, skills and tools.',
    pieces: [
      { need: 'the messaging channels pane', path: `${VERSE}/fleet-channels/FleetChannelsPane.tsx`, exportName: 'FleetChannelsPane' },
      { need: 'the connectors panel', path: 'src/web-ui/routes/settings/connectors/ConnectorsView.tsx', exportName: 'ConnectorsSettings' },
      { need: 'the tools (MCP) panel', path: `${VERSE}/sections/McpSection.tsx`, exportName: 'McpSection' },
      { need: 'a plugins panel' },
      { need: 'a skills panel' },
    ],
  },
  {
    id: 'A3',
    title: 'Metrics',
    ask: 'Graphs for high-leverage PRs merged, autonomy, and usage spend-down per resource.',
    pieces: [
      { need: 'the metrics pane', path: `${VERSE}/fleet-metrics/MetricsPane.tsx`, exportName: 'MetricsPane' },
      { need: 'spend-down per resource', path: `${VERSE}/resources/SpendDown.tsx`, exportName: 'SpendDown' },
      { need: 'the autonomy view', path: `${VERSE}/sections/AutonomySection.tsx`, exportName: 'AutonomySection' },
      { need: 'the fleet metrics CLI verb', path: 'src/cli/fleet-metrics.ts', exportName: 'cmdFleetMetrics' },
      { need: 'a graph of high-leverage PRs merged over time' },
      { need: 'a graph of autonomy over time' },
    ],
  },
  {
    id: 'A4',
    title: 'Leader thread',
    ask: 'One main Chat with the Leader in the desktop app and phone view, tied to iMessage, Slack, Telegram and email.',
    pieces: [
      { need: 'the desktop Leader thread pane', path: `${VERSE}/leader-thread/LeaderThreadPane.tsx`, exportName: 'LeaderThreadPane' },
      { need: 'the iMessage, Slack, Telegram and email strip', path: `${VERSE}/leader-thread/OwnerChannelsStrip.tsx`, exportName: 'OwnerChannelsStrip' },
      { need: 'the phone Leader screen', path: `${VERSE}/mobile/screens/LeaderScreen.tsx`, exportName: 'LeaderScreen' },
      { need: 'the fleet leader CLI verb', path: 'src/cli/fleet-leader.ts', exportName: 'cmdFleetLeader' },
    ],
  },
  {
    id: 'A5',
    title: 'MetaMuse layout',
    ask: 'Five areas: Chat, Feed (news, alerts, fleet updates), Ideas (what to do next), Goals (metrics, vision, direction) and Library (files, media, context, memory, agent messages).',
    pieces: [
      { need: 'the five MetaMuse sections', path: `${VERSE}/shell/pane-sections.ts`, exportName: 'PANE_SECTIONS' },
      { need: 'the Feed pane', path: `${VERSE}/feed/feed.pane.tsx` },
      { need: 'the Ideas pane', path: `${VERSE}/ideas/ideas.pane.tsx` },
      { need: 'the Goals pane', path: `${VERSE}/goals-pane/goals.pane.tsx` },
      { need: 'the Library pane', path: `${VERSE}/library/LibraryPane.tsx`, exportName: 'LibraryPane' },
      { need: 'media in the Library', path: `${VERSE}/library/MediaSection.tsx`, exportName: 'MediaSection' },
      { need: 'memory in the Library', path: `${VERSE}/library/CosMemorySection.tsx`, exportName: 'CosMemorySection' },
      { need: 'the phone Feed screen', path: `${VERSE}/mobile/screens/FeedScreen.tsx`, exportName: 'FeedScreen' },
      { need: 'the phone Ideas screen', path: `${VERSE}/mobile/screens/IdeasScreen.tsx`, exportName: 'IdeasScreen' },
      { need: 'the phone Goals screen', path: `${VERSE}/mobile/screens/GoalsScreen.tsx`, exportName: 'GoalsScreen' },
      { need: 'a Library screen in the phone view' },
    ],
  },
  {
    id: 'A6',
    title: 'Appearance',
    ask: 'Settings > Appearance with light, dark and system themes, accent color, density and font size, persisted and applied live.',
    pieces: [
      { need: 'the Settings page', path: `${VERSE}/sections/SettingsSection.tsx`, exportName: 'SettingsSection' },
      { need: 'the Appearance panel', path: `${VERSE}/sections/AppearancePanel.tsx`, exportName: 'AppearancePanel' },
      { need: 'live apply of appearance', path: 'src/web-ui/data/appearance-hooks.ts', exportName: 'useAppearance' },
      { need: 'the persisted appearance file', path: 'src/core/verse/ui-appearance-file.ts', exportName: 'readUiAppearanceFile' },
      { need: 'the fleet appearance CLI verb', path: 'src/cli/fleet-appearance.ts', exportName: 'cmdFleetAppearance' },
    ],
  },
  {
    id: 'A7',
    title: 'Self-update',
    ask: 'The installed app updates itself in place from published releases without interrupting running fleet work.',
    pieces: [
      { need: 'the desktop updater config', path: 'desktop/src-tauri/tauri.conf.json' },
      { need: 'the native update runtime', path: 'desktop/src-tauri/src/native_updates.rs' },
      { need: 'auto-update that waits for running workers', path: `${VERSE}/sections/update-auto-model.ts`, exportName: 'decideAutoUpdate' },
      { need: 'the in-app auto-update hook', path: `${VERSE}/sections/useAutoSelfUpdate.ts`, exportName: 'useAutoSelfUpdate' },
      { need: 'the update CLI verb', path: 'src/cli/update.ts', exportName: 'cmdUpdate' },
    ],
  },
  {
    id: 'A8',
    title: 'No approvals',
    ask: 'The app never waits on a human except for passwords, 2FA, device approvals and payments; the "Needs you" list auto-resolves everything else.',
    pieces: [
      { need: 'the Needs-you triage rules', path: 'src/core/fleet/needs-mason-triage.ts', exportName: 'classifyNeedsItem' },
      { need: 'the Needs-you drawer', path: `${VERSE}/shell/NeedsYouDrawer.tsx`, exportName: 'NeedsYouDrawer' },
      { need: 'the phone Needs-you screen', path: `${VERSE}/mobile/screens/NeedsYouScreen.tsx`, exportName: 'NeedsYouScreen' },
      { need: 'the fleet needs-triage CLI verb', path: 'src/cli/fleet-needs-triage.ts', exportName: 'cmdFleetNeedsTriage' },
      // classifyNeedsItem still holds outside sends, data deletes and signing for Mason.
      { need: 'a Needs-you rule that holds only passwords, 2FA, device approvals and payments' },
    ],
  },
  {
    id: 'A9',
    title: 'Live usage',
    ask: 'The Resources view shows live usage readings and reset times per plan, with unknown shown as unknown.',
    pieces: [
      { need: 'the Resources view', path: `${VERSE}/resources/ResourcesDrawer.tsx`, exportName: 'ResourcesDrawer' },
      { need: 'reset times per plan', path: `${VERSE}/resources/ResetsTimeline.tsx`, exportName: 'ResetsTimeline' },
      { need: 'unknown readings named as unknown', path: `${VERSE}/resources/missing-reading-reason.ts`, exportName: 'missingReadingReason' },
      { need: 'the live usage CLI verb', path: 'src/cli/usage-resource-live.ts', exportName: 'cmdUsageResourceLive' },
    ],
  },
];
