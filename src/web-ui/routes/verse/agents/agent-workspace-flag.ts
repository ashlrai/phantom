import { useFeatureFlag } from '../../../app/desktop-state.js';
import { getFeatureFlag } from '../../../data/feature-flags.js';

/** `?agentWorkspace=1` previews the feature for this page only. */
function urlOptIn(): boolean {
  return typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentWorkspace') === '1';
}

/**
 * Explicit opt-in, on either surface: the saved Workspace setting (Settings ▸
 * Workspace, kept in this browser) or `?agentWorkspace=1` in the URL. Absent,
 * malformed and server-side reads stay off.
 */
export function agentWorkspaceEnabled(): boolean {
  return getFeatureFlag('agentWorkspace') || urlOptIn();
}

/** The opt-in for React: re-renders when the saved setting flips. */
export function useAgentWorkspaceEnabled(): boolean {
  return useFeatureFlag('agentWorkspace') || urlOptIn();
}
