import { useQuery, useRefetch } from '../../../data/hooks.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { WorkspaceGraph } from './WorkspaceGraph.js';
import { buildRunsGraph, describeRunsGraph, runsWorkspaceGraph } from './runs-graph-model.js';
import { runsGraphQuery } from './runs-graph-queries.js';
import styles from './runs-graph.module.css';

export function RunsGraph() {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(runsGraphQuery, { enabled: sectionVisible && documentVisible });
  const refetch = useRefetch(runsGraphQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: read.data !== null });
  const graph = read.data ? buildRunsGraph(read.data, read.updatedAt ?? Date.now()) : null;
  return <section className={styles.graph} aria-label="Runs graph">
    <header><h3>Runs graph</h3>
      <p role="status">{graph ? describeRunsGraph(graph) : read.data === null ? 'Not in this build yet.' : read.error ? 'Runs could not be read.' : 'Reading runs…'}</p>
      {read.status === 'refreshing' ? <RefreshIndicator /> : null}
      {read.data?.switches.length ? <span className={styles.danger}>Switches on: {read.data.switches.join(', ')}</span> : null}
      {graph && read.error ? <p>Last recorded runs · refresh failed.</p> : null}
    </header>
    {graph ? <>
      <p>Leaders → lanes → jobs → merges. Inferred dispatch links are dashed. Merge links indicate a matching repository.</p>
      {graph.nodes.length === 0 ? <p>No runs right now.</p> : <div ref={element => {
        // WorkspaceGraph has no title prop; enrich its existing native DOM hooks.
        if (!element) return;
        for (const button of element.querySelectorAll('button[aria-label]')) {
          const id = button.getAttribute('aria-label')?.replace('Inspect workspace node ', '');
          const node = graph.nodes.find(n => n.id === id);
          if (node) button.setAttribute('title', node.title);
        }
        for (const path of element.querySelectorAll('path[role="img"]')) {
          const edge = graph.edges.find(e => path.getAttribute('aria-label') === `${e.kind}: ${e.from} → ${e.to}`);
          if (edge) { path.querySelector('title')!.textContent = edge.title; path.setAttribute('aria-label', edge.title); if (edge.inferred) path.setAttribute('stroke-dasharray', '5 4'); }
        }
      }}><WorkspaceGraph graph={runsWorkspaceGraph(graph)} /></div>}
    </> : null}
  </section>;
}
