import { lazyPane, registerPane } from '../panes/pane-registry.js';
import { isAgentWorkspaceEnabled } from './agent-workspace.js';

function ReplayIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M3 5a5.5 5.5 0 1 1-0.3 5M3 1v4h4M7 5.5l4 2.5-4 2.5z" />
  </svg>;
}

registerPane({
  id: 'run-replay',
  title: 'Run replay',
  icon: ReplayIcon,
  component: lazyPane(() => import('./ReplayPane.js').then((m) => m.ReplayPane)),
  when: isAgentWorkspaceEnabled,
  needsSession: false,
  order: 95,
  description: 'Step through a finished run’s recorded messages, commands and changes.',
});
