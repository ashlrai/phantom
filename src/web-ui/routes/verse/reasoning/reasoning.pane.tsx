/**
 * routes/verse/reasoning/reasoning.pane.tsx — the Reasoning pane, registered with the workbench pane registry (panes/README.md).
 *
 * The id replaces the first-party stub and inherits its key (⇧⌘Y), order
 * and catalog command. Only the
 * registration lives here — panes/index.ts imports every `*.pane.tsx` eagerly
 * after first paint — and its body is its own lazy chunk.
 */
import { ReasoningGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'reasoning',
  title: 'Reasoning',
  icon: ReasoningGlyph,
  description: "The model's reasoning, turn by turn, with what each turn did.",
  component: lazyPane(() => import('./dock-panes.js').then((m) => m.ReasoningDockPane)),
});
