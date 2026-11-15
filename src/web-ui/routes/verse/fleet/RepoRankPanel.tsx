import { useEffect, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { scoreParts, type RepoRankState } from './repo-rank-model.js';

export function RepoRankPanel() {
  const [state, setState] = useState<RepoRankState | null | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void apiGet<RepoRankState | null>('/api/repos/rank').then(value => {
      if (active) setState(value);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  return <section aria-label="Repository ranking">
    <h2>Repository ranking</h2>
    {error ? <p role="status">Could not read repository ranking.</p> : state === undefined ? <p>Reading repository ranking...</p> : state === null ? <p>No ranking has been computed yet. Run phm repos rank --json.</p> : <>
      <p>Last recomputed: <time dateTime={state.generatedAt}>{state.generatedAt}</time></p>
      <table><thead><tr><th>Rank</th><th>Repository</th><th>Weight</th><th>Score</th><th>Prior</th><th>Recency</th><th>Leverage</th></tr></thead>
        <tbody>{state.rankings.map((row, index) => {
          const parts = scoreParts(state, row);
          return <tr key={row.repo}><td>{index + 1}</td><td>{row.repo}</td><td>{(row.weight * 100).toFixed(1)}%</td><td>{row.score.toFixed(3)}</td><td>{parts.prior.toFixed(3)}</td><td>{parts.recency.toFixed(3)}</td><td>{parts.leverage.toFixed(3)}</td></tr>;
        })}</tbody></table>
      <h3>Proposals (proposed, not enrolled)</h3>
      {state.proposals.length ? <ul>{state.proposals.map(row => <li key={row.repo}>{row.repo}</li>)}</ul> : <p>No proposals.</p>}
    </>}
  </section>;
}
