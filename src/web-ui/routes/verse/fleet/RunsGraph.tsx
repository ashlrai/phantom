import { useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { WorkspaceGraph } from './WorkspaceGraph.js';
import { buildRunsGraph, describeRunsGraph, nodeAction, runsWorkspaceGraph } from './runs-graph-model.js';
import { runsGraphQuery } from './runs-graph-queries.js';
import styles from './runs-graph.module.css';

export function RunsGraph() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(runsGraphQuery, { enabled: sectionVisible && documentVisible });
  const refetch = useRefetch(runsGraphQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: read.data !== null });
  const graph = read.data ? buildRunsGraph(read.data, read.updatedAt ?? Date.now()) : null;
  const selected = graph?.nodes.find(node => node.id === selectedId);
  const action = graph && read.data ? nodeAction(graph, selectedId, read.data) : null;
  return <section className={styles.graph} aria-label="Runs graph">
    <header><h3>Runs graph</h3>
      <p role="status">{graph ? describeRunsGraph(graph) : read.data === null ? 'Not in this build yet.' : read.error ? 'Runs could not be read.' : 'Reading runs…'}</p>
      {read.status === 'refreshing' ? <RefreshIndicator /> : null}
      {read.data?.switches.length ? <span className={styles.danger}>Switches on: {read.data.switches.join(', ')}</span> : null}
      {graph && read.error ? <p>Last recorded runs · refresh failed.</p> : null}
    </header>
    {graph ? <>
      <p>Leaders → lanes → jobs → merges. Inferred dispatch links are dashed. Merge links indicate a matching repository.</p>
      {graph.nodes.length === 0 ? <p>No runs right now.</p> : null}
      <div hidden={graph.nodes.length === 0} ref={element => {
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
      }}><WorkspaceGraph graph={runsWorkspaceGraph(graph)} onSelect={setSelectedId} /></div>
      {selected ? <div className={styles.actions} role="group" aria-label="Selected node">
        <span>{selected.label}</span>
        {action?.kind === 'log' ? <button type="button" onClick={() => { requestWorkerLogJob(action.job); openDockPane('worker-log'); }}>Open worker log</button>
          : action?.kind === 'pr' ? <a href={action.url} target="_blank" rel="noopener noreferrer">{action.label}</a>
          : action?.kind === 'lanes' ? <button type="button" onClick={() => openDockPane('fleet-lanes')}>Open Lanes pane</button> : null}
      </div> : null}
    </> : null}
  </section>;
}
