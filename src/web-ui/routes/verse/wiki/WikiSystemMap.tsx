import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError } from '../context/use-token-gate.js';
import { githubCitationUrl, shortSha } from './wiki-model.js';
import { wikiEcosystemQuery, wikiSystemMapQuery, type SystemMapResult } from './wiki-queries.js';
import styles from './WikiSystemMap.module.css';

type Graph = Extract<SystemMapResult, { nodes: unknown }>;
type Node = Graph['nodes'][number];
type Anchor = Node['anchor'];
type Location = { trail: Node[]; commit: string | null };
const ROOT: Location = { trail: [], commit: null };
const KINDS: Record<Node['kind'], string> = {
  module: 'Subsystem', file: 'File', test: 'Test', symbol: 'Symbol', cli: 'CLI verb', route: 'HTTP route', mcp: 'MCP tool',
};
const COLS = 3;
const WIDTH = 204;
const HEIGHT = 64;
const DX = 230;
const DY = 88;
const ARROW_STEPS: Readonly<Record<string, number | undefined>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS };
const position = (index: number) => ({ x: 16 + (index % COLS) * DX, y: 16 + Math.floor(index / COLS) * DY });

function linkPath(from: number, to: number): string {
  const a = position(from), b = position(to);
  if (a.y === b.y) {
    const leftToRight = a.x < b.x;
    const x = a.x + (leftToRight ? WIDTH : 0), end = b.x + (leftToRight ? 0 : WIDTH);
    if (Math.abs(from - to) === 1) return `M${x},${a.y + 32} H${end}`;
    const start = a.x + WIDTH / 2, target = b.x + WIDTH / 2;
    return `M${start},${a.y} C${start},${a.y - 20} ${target},${a.y - 20} ${target},${a.y}`;
  }
  const down = a.y < b.y;
  const x = a.x + WIDTH / 2, end = b.x + WIDTH / 2;
  const y = a.y + (down ? HEIGHT : 0), target = b.y + (down ? 0 : HEIGHT);
  return `M${x},${y} C${x},${(y + target) / 2} ${end},${(y + target) / 2} ${end},${target}`;
}

function Source({ anchor, githubUrl, linkLabel }: { anchor: Anchor; githubUrl: string | null; linkLabel?: string }) {
  const url = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(anchor.commit) ? githubCitationUrl(githubUrl, anchor.commit, anchor) : null;
  return <div className={styles.source}>
    <code>{anchor.file}:{anchor.line}</code>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">{linkLabel ?? 'Open pinned source'} ↗</a> : null}
  </div>;
}

function Diagram({ graph, githubUrl, navigate }: { graph: Graph; githubUrl: string | null; navigate: (node: Node) => void }) {
  const [choice, setChoice] = useState(graph.focus);
  const allNodes = new Map(graph.nodes.map(node => [node.id, node]));
  const focus = graph.focus ? allNodes.get(graph.focus) : undefined;
  const local = focus && focus.kind !== 'module' ? new Set([focus.id]) : null;
  if (local && focus) for (const edge of graph.edges) {
    if (edge.kind === 'contains' && edge.from === focus.id) local.add(edge.to);
    if (edge.kind === 'contains' && edge.to === focus.id) local.add(edge.from);
  }
  const nodes = local ? graph.nodes.filter(node => local.has(node.id)) : graph.nodes;
  const selected = nodes.find(node => node.id === choice);
  const positions = new Map(nodes.map((node, i) => [node.id, i]));
  const related = selected ? graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id) : [];
  const cardRefs = useRef(new Map<string, SVGGElement>());
  const marker = useId();
  const rows = Math.ceil(nodes.length / COLS);
  if (!nodes.length) return <p>No anchored nodes in this view.</p>;

  const handleCardKey = (event: KeyboardEvent<SVGGElement>, node: Node, index: number) => {
    const step = ARROW_STEPS[event.key];
    if (step !== undefined || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = nodes[event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : index + step!];
      if (next) {
        setChoice(next.id);
        cardRefs.current.get(next.id)?.focus();
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setChoice(node.id);
      if (event.key === 'Enter' && node.id !== graph.focus) navigate(node);
    }
  };

  return <div className={styles.layout}>
    <div className={styles.viewport}>
      <svg className={styles.diagram} viewBox={`0 0 696 ${rows * DY + 8}`} role="group" aria-label="Source graph">
        <defs><marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L8 4 L0 8 Z" /></marker></defs>
        <g className={styles.edges} aria-hidden="true">
          {related.map((edge, i) => {
            const from = positions.get(edge.from), to = positions.get(edge.to);
            return from === undefined || to === undefined || from === to ? null : <path key={i} d={linkPath(from, to)} data-kind={edge.kind} markerEnd={`url(#${marker})`} />;
          })}
        </g>
        {nodes.map((node, index) => {
          const { x, y } = position(index);
          const label = node.kind === 'file' || node.kind === 'test' ? node.label.split('/').at(-1)! : node.label;
          return <g key={node.id} ref={el => { if (el) cardRefs.current.set(node.id, el); else cardRefs.current.delete(node.id); }}
            className={styles.card} transform={`translate(${x} ${y})`}
            role="button" aria-label={`${KINDS[node.kind]}: ${node.label}`} aria-pressed={selected?.id === node.id}
            tabIndex={node.id === (selected?.id ?? nodes[0]?.id) ? 0 : -1}
            onClick={() => { setChoice(node.id); cardRefs.current.get(node.id)?.focus(); }}
            onKeyDown={event => handleCardKey(event, node, index)}>
            <title>{node.label}</title>
            <rect width={WIDTH} height={HEIGHT} rx="8" />
            <text x="14" y="22" className={styles.nodeKind}>{KINDS[node.kind]}</text>
            <text x="14" y="45" className={styles.nodeLabel}>{label.length > 24 ? `${label.slice(0, 23)}…` : label}</text>
            {node.id === graph.focus ? <circle cx="185" cy="19" r="4" /> : null}
          </g>;
        })}
      </svg>
    </div>
    <aside className={styles.detail} aria-label="Source details">
      <p className={styles.eyebrow}>Selected node</p>
      {selected ? <>
        <h3>{selected.label}</h3>
        <p className={styles.kind}>{KINDS[selected.kind]}</p>
        <Source anchor={selected.anchor} githubUrl={githubUrl} />
        {selected.id !== graph.focus ? <button type="button" className={styles.explore} onClick={() => navigate(selected)}>
          {selected.kind === 'module' ? 'Explore subsystem' : selected.kind === 'file' || selected.kind === 'test' ? 'Explore file' : 'Inspect declaration'} →
        </button> : null}
        <h4>Connections <span>{related.length}</span></h4>
        {related.length ? <ul>{related.map((edge, i) => {
          const other = allNodes.get(edge.from === selected.id ? edge.to : edge.from);
          return <li key={i}>
            <span>{edge.kind === 'contains' ? edge.from === selected.id ? 'Contains' : 'Contained by' : edge.from === selected.id ? 'Imports' : 'Imported by'}</span>
            {other ? <button type="button" onClick={() => positions.has(other.id) ? setChoice(other.id) : navigate(other)}>{other.label}</button> : null}
            {edge.kind === 'imports' ? <Source anchor={edge.anchor} githubUrl={githubUrl} linkLabel="Import evidence" /> : null}
          </li>;
        })}</ul> : <p>No connections in this view.</p>}
      </> : <p>Select a node to see its source anchor and connections.</p>}
    </aside>
  </div>;
}

const EDGE_LABEL = {
  'npm-dependency': 'npm dependency', 'mcp-companion': 'MCP companion', 'package-import': 'Package import',
  'cargo-dependency': 'Cargo dependency', 'python-dependency': 'Python dependency', 'git-submodule': 'Git submodule',
  'github-action': 'GitHub Action', 'brew-formula': 'Homebrew formula',
} as const;

function ecosystemPath(from: number, to: number): string {
  const a = position(from), b = position(to);
  if (Math.abs(a.y - b.y) <= DY) return linkPath(from, to);
  const aX = a.x + WIDTH / 2, bX = b.x + WIDTH / 2;
  const direction = a.y < b.y ? 1 : -1;
  const start = a.y + (direction === 1 ? HEIGHT : 0);
  const end = b.y + (direction === 1 ? 0 : HEIGHT);
  const gutter = a.x + WIDTH + (DX - WIDTH) / 2;
  return `M${aX},${start} v${direction * 10} H${gutter} V${end - direction * 10} H${bX} V${end}`;
}

function Ecosystem({ back }: { back: () => void }) {
  const { data, error, status } = useQuery(wikiEcosystemQuery, { freshMs: 0 });
  const refetch = useRefetch(wikiEcosystemQuery);
  const [choice, setChoice] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const marker = useId();
  useEffect(() => heading.current?.focus(), []);
  const repos = data?.repos ?? [];
  const selected = repos.find(repo => repo.repo === choice) ?? repos.find(repo => repo.commit) ?? repos[0];
  const index = new Map(repos.map(({ repo }, i) => [repo, i]));
  const edges = data?.edges.filter(edge => edge.from === selected?.repo || edge.to === selected?.repo) ?? [];
  const indexed = repos.filter(repo => repo.commit).length;
  return <section className={styles.root} aria-label="Signed-grant ecosystem map" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); back(); }
  }}>
    <nav className={styles.breadcrumb} aria-label="System map breadcrumb">
      <button type="button" onClick={back}>Overview</button><span aria-current="page">/ Ecosystem</span>
    </nav>
    <div className={styles.header}><div><p className={styles.eyebrow}>Repo Wiki · System map</p>
      <h2 ref={heading} tabIndex={-1}>Ecosystem</h2></div></div>
    {error ? <div role="alert"><p>{describeContextError(error)}</p><button type="button" onClick={refetch}>Retry map</button></div> :
      !data ? <p role="status">Reading the signed repository scope…</p> :
        data.status !== 'current' ? <p role="status">No verified standing grant scope is available.</p> : <>
          <div className={styles.coverage}><span><strong>{indexed} of {repos.length}</strong> signed repos indexed</span>
            <span>{data.edges.length} source-linked relationships</span>{data.truncated && <strong>View truncated</strong>}
            <button type="button" onClick={refetch} disabled={status === 'refreshing'}>Refresh map</button></div>
          <div className={styles.layout}>
            <div className={styles.viewport}><svg className={styles.diagram} viewBox={`0 0 710 ${Math.ceil(repos.length / COLS) * DY + 8}`} aria-label="Repositories in the signed grant">
              <defs><marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L8 4 L0 8 Z" /></marker></defs>
              <g className={styles.edges} aria-hidden="true">{edges.map(edge => <path key={`${edge.from}:${edge.to}:${edge.kind}`}
                d={ecosystemPath(index.get(edge.from)!, index.get(edge.to)!)} markerEnd={`url(#${marker})`} />)}</g>
              {repos.map(({ repo, commit }, i) => {
                const { x, y } = position(i);
                const name = repo.split('/')[1] ?? repo;
                return <g key={repo} className={styles.card} transform={`translate(${x} ${y})`} role="button" tabIndex={0}
                  aria-label={repo} aria-pressed={selected?.repo === repo} onClick={() => setChoice(repo)} onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setChoice(repo); }
                  }}>
                  <title>{repo}</title><rect width={WIDTH} height={HEIGHT} rx={8} />
                  <text className={styles.nodeKind} x={12} y={22}>{commit ? shortSha(commit) : 'Not indexed'}</text>
                  <text className={styles.nodeLabel} x={12} y={45}>{name.length > 23 ? `${name.slice(0, 22)}…` : name}</text>
                </g>;
              })}
            </svg></div>
            <aside className={styles.detail} aria-label="Repository relationships">
              <p className={styles.eyebrow}>Selected repository</p>
              <h3>{selected?.repo}</h3>
              {selected?.commit ? <p>Pinned at <code>{shortSha(selected.commit)}</code></p> : <p>No matching local checkout was indexed.</p>}
              <h4>Connections <span>{edges.length}</span></h4>
              {edges.length ? <ul>{edges.map(edge => <li key={`${edge.from}:${edge.to}:${edge.kind}`}>
                <span>{EDGE_LABEL[edge.kind]} · {edge.from === selected?.repo ? 'outgoing' : 'incoming'}</span>
                <button type="button" onClick={() => setChoice(edge.from === selected?.repo ? edge.to : edge.from)}>
                  {edge.from === selected?.repo ? edge.to : edge.from}
                </button>
                <Source anchor={edge.anchor} githubUrl={`https://github.com/${edge.from}`} />
              </li>)}</ul> : <p>No indexed connections.</p>}
            </aside>
          </div>
        </>}
  </section>;
}

export function WikiSystemMap(props: { repoKey: string; githubUrl: string | null }) {
  const [ecosystem, setEcosystem] = useState(false);
  return ecosystem ? <Ecosystem back={() => setEcosystem(false)} /> :
    <RepoSystemMap {...props} openEcosystem={() => setEcosystem(true)} />;
}

function RepoSystemMap({ repoKey, githubUrl, openEcosystem }: { repoKey: string; githubUrl: string | null; openEcosystem: () => void }) {
  const [location, setLocation] = useState<Location>(ROOT);
  const [moved, setMoved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const current = location.trail.at(-1);
  const def = wikiSystemMapQuery(repoKey, current?.id, location.commit);
  const { data, error, status } = useQuery(def, { freshMs: 0 });
  const refetch = useRefetch(def);
  const graph = data && 'commit' in data ? data : null;
  const changed = graph && location.commit !== null && graph.commit !== location.commit;
  const waiting = status === 'loading' || status === 'refreshing' || status === 'idle';

  useEffect(() => {
    if (waiting) return;
    if (changed) {
      setLocation(ROOT);
      setMoved(true);
    } else if (moveFocus.current) {
      heading.current?.focus();
      moveFocus.current = false;
    }
  }, [changed, waiting]);

  const go = (trail: Node[], commit: string | null = graph?.commit ?? null) => {
    moveFocus.current = true;
    setMoved(false);
    setLocation({ trail, commit: trail.length ? commit : null });
  };
  const navigate = (node: Node) => {
    if (node.kind === 'module') return go([node]);
    if (node.kind === 'file' || node.kind === 'test') {
      const parent = graph?.edges.find(edge => edge.kind === 'contains' && edge.to === node.id);
      const module = graph?.nodes.find(candidate => candidate.kind === 'module' && candidate.id === parent?.from);
      return go(module ? [module, node] : [node]);
    }
    go([...location.trail, node]);
  };
  const title = current?.label ?? 'Subsystem overview';
  return <section className={styles.root} aria-label="Commit-pinned system map" onKeyDown={event => {
    if (event.key === 'Escape' && location.trail.length > 0) { event.preventDefault(); go(location.trail.slice(0, -1)); }
  }}>
    <nav className={styles.breadcrumb} aria-label="System map breadcrumb">
      <button type="button" onClick={openEcosystem}>Ecosystem</button><span aria-hidden="true">/</span>
      <button type="button" onClick={() => go([])} aria-current={current ? undefined : 'page'}>Overview</button>
      {location.trail.map((node, i) => <span key={node.id}><span aria-hidden="true">/</span>
        <button type="button" onClick={() => go(location.trail.slice(0, i + 1))} aria-current={node.id === current?.id ? 'page' : undefined}>{node.label}</button>
      </span>)}
    </nav>
    <div className={styles.header}>
      <div><p className={styles.eyebrow}>Repo Wiki · System map</p><h2 ref={heading} tabIndex={-1}>{title}</h2></div>
      {graph && !changed ? <div className={styles.commit}><span>Pinned commit</span><code title={graph.commit}>{shortSha(graph.commit)}</code></div> : null}
    </div>
    {moved ? <p role="status">HEAD changed. Returned to the overview at the new commit.</p> : null}
    {waiting || changed ? <p role="status">Reading the pinned source map…</p> : error || !graph || graph.status !== 'current' ?
      <div role="alert">
        <p>{error ? describeContextError(error) : graph?.status === 'not-found' ? 'This node is not indexed at the current commit.' : 'The system map is unavailable.'}</p>
        <button type="button" onClick={refetch}>Retry map</button>
      </div> : <>
        <div className={styles.coverage} aria-label="Map coverage">
          <span><strong>{graph.coverage.files.toLocaleString()}</strong> indexed</span>
          <span>{graph.coverage.ignored} ignored</span><span>{graph.coverage.skipped} skipped</span>
          <span>{graph.coverage.limited} limited</span><span>{graph.coverage.unresolvedImports.toLocaleString()} unresolved imports</span>
          {graph.truncated ? <strong>View truncated</strong> : null}
        </div>
        <Diagram key={`${graph.commit}:${graph.focus ?? ''}`} graph={graph} githubUrl={githubUrl} navigate={navigate} />
        <p className={styles.guide}>Arrow keys select · Enter drills down · Esc goes back. The details panel lists the selected node’s connections.</p>
      </>}
  </section>;
}
