/**
 * The drawings inside Home's Running jobs and Main cards. Both draw only what the `phm home` summary holds:
 * a tile per lane (provider mark, jobs running, a square per target slot) and a mark per repository's default branch.
 * Read-only; each card keeps its one action in HomePane. A lane with no recorded target gets no slots and no bar.
 */
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { laneTiles, lanesSummary, mainSummary, repoMarks, type HomeLane, type HomeRepo, type LaneTile } from './home-readings-model.js';
import styles from './home-readings.module.css';

function Tile({ tile }: { tile: LaneTile }) {
  const { lane, running, target, percent, pips, over } = tile;
  return <li className={styles.tile} data-idle={running === 0 || undefined}>
    <span className={styles.name} aria-hidden="true"><ProviderBadge of={lane} iconOnly size={14} /><span className={styles.laneName}>{lane}</span></span>
    <span className={styles.figure} aria-hidden="true"><strong>{running}</strong>{target === null ? <span data-unknown>no target</span> : `of ${target}`}</span>
    {/* The sentence `phm home` prints; the mark, figure and squares above and below repeat it. */}
    <span className="visually-hidden">{tile.words}</span>
    {percent !== null && <span role="meter" className={pips ? styles.pips : styles.track} aria-label={`${lane} running of target`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${running} of ${target} running`}>
      {pips ? pips.map((filled, slot) => <i key={slot} className={styles.pip} data-filled={filled || undefined} />)
        : <i className={styles.fill} style={{ width: `${percent}%` }} />}
    </span>}
    {over > 0 && <span className={styles.over}>{over} over target</span>}
  </li>;
}

/** Running jobs: one line of totals, then a tile per lane in the summary's order. */
export function RunningLanes({ lanes }: { lanes: readonly HomeLane[] }) {
  return <div className={styles.body}>
    <p className={styles.note}>{lanesSummary(lanes)}</p>
    <ul className={styles.tiles} aria-label="Running jobs by lane">{laneTiles(lanes).map(tile => <Tile key={tile.lane} tile={tile} />)}</ul>
  </div>;
}

/** Main: one line saying where the default branches stand, then a mark per repository, red first. */
export function MainRepos({ repos }: { repos: readonly HomeRepo[] }) {
  const summary = mainSummary(repos);
  return <div className={styles.body}>
    <p className={styles.note} data-tone={summary.tone}>{summary.text}</p>
    <ul className={styles.repos} aria-label="Default branch by repository">
      {repoMarks(repos).map(repo => <li key={repo.repo} data-state={repo.state}>{repo.repo}: {repo.state}</li>)}
    </ul>
  </div>;
}
