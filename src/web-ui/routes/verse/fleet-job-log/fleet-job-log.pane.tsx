import { lazyPane, registerPane } from '../panes/pane-registry.js';

function WorkerLogGlyph({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="m4.5 6 2 2-2 2M8.5 10h3" /></svg>;
}

registerPane({
  id: 'worker-log', title: 'Worker log', description: 'Live tail of a running fleet worker on this Mac',
  needsSession: false, icon: WorkerLogGlyph,
  component: lazyPane(() => import('./WorkerLogPane.js').then(m => m.WorkerLogPane)),
});
