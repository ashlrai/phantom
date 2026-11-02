/** Persisted shapes from v3.29.15; onboarding is a separate localStorage key. */
export const UI_STATE_3_29_15 = {
  version: 3,
  section: 'fleet',
  railExpanded: true,
  sidebarWidth: 264,
  sidebarCollapsed: false,
  resourcesOpen: true,
  resourcesWidth: 320,
  recentActions: ['dock.preview'],
  recentChats: ['chat-1'],
  lastLaunchDay: '2026-09-20',
  chatMovedAnnounced: true,
  dock: {
    open: true,
    width: 440,
    tabs: ['preview', 'terminal', 'fleet-lanes', 'gone-pane'],
    active: 'preview',
    splitWith: null,
    splitRatio: 0.5,
    placement: 'right',
    height: 300,
    byChat: {
      'chat-2': { open: true, tabs: ['terminal', 'preview'], active: 'preview', splitWith: 'terminal' },
    },
  },
};

export const ONBOARDING_3_29_15 = {
  completedAt: '2026-09-20T10:00:00.000Z',
  dismissedAt: null,
  expanded: false,
  step: 5,
};
