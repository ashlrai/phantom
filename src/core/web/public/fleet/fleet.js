/* Read-only phone projection. All untrusted strings enter through textContent. */
(() => {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const POLL_MS = 30000;
  const names = { 'grok-ultra-weekly': 'Grok Ultra weekly', 'codex-cmp': 'Codex · CMP', 'codex-personal': 'Codex · personal', 'claude-max': 'Claude Max', devin: 'Devin', 'grok-build': 'Grok Build', cursor: 'Cursor', omlx: 'oMLX' };
  const list = value => Array.isArray(value) ? value : [];
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = value => typeof value === 'string' && value ? value : 'unknown';
  const percent = value => number(value) === null ? 'unknown' : `${value.toFixed(1).replace(/\.0$/, '')}%`;
  const hours = value => number(value) === null ? 'unknown' : value >= 48 ? `${(value / 24).toFixed(1)} days` : `${value.toFixed(1)} hours`;
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
  const stamp = value => date(value)?.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) ?? 'unknown';
  const age = value => number(value) === null ? 'age unknown' : value < 60 ? `${Math.floor(value)}s old` : value < 3600 ? `${Math.floor(value / 60)}m old` : value < 86400 ? `${(value / 3600).toFixed(1)}h old` : `${(value / 86400).toFixed(1)}d old`;
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }
  function svg(tag, attrs, content) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (content !== undefined) node.textContent = String(content);
    return node;
  }
  function empty(target, content) { target.replaceChildren(el('p', 'empty', content)); }
  function fact(label, value) { const node = el('div', 'fact'); node.append(el('span', '', label), el('strong', '', value)); return node; }
  function validPoints(value) { return list(value).filter(p => p && date(p.at) && number(p.used_pct) !== null && p.used_pct >= 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); }
  function chart(pool) {
    const actual = validPoints(pool.actual);
    const ideal = validPoints(pool.ideal);
    const planner = validPoints(pool.planner);
    const reset = date(pool.reset_at);
    const reading = date(pool.reading_at);
    const projected = number(pool.projected_pct);
    const used = number(pool.used_pct);
    const points = [...actual, ...ideal, ...planner];
    if (reading && used !== null) points.push({ at: reading.toISOString(), used_pct: used });
    const start = date(pool.window_start)?.getTime() ?? Math.min(...points.map(p => Date.parse(p.at)));
    const end = reset?.getTime() ?? Math.max(...points.map(p => Date.parse(p.at)));
    const max = Math.max(100, projected ?? 0, ...points.map(p => p.used_pct));
    const ceiling = Math.ceil(max / 25) * 25;
    const x = at => 40 + Math.max(0, Math.min(1, (Date.parse(at) - start) / Math.max(1, end - start))) * 452;
    const y = value => 128 - Math.max(0, Math.min(ceiling, value)) / ceiling * 100;
    const graph = svg('svg', { viewBox: '0 0 520 164', role: 'img', class: 'chart' });
    const title = svg('title', {}, `${names[pool.id] ?? text(pool.id)} usage: ${percent(used)}; ideal now ${percent(pool.ideal_pct)}; projected at reset ${percent(projected)}.`);
    graph.append(title);
    for (const v of [0, ceiling / 2, ceiling]) {
      graph.append(svg('line', { x1: 40, x2: 492, y1: y(v), y2: y(v), class: 'grid-line' }), svg('text', { x: 32, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' }, `${v}%`));
    }
    const line = (data, className) => {
      if (data.length > 1) graph.append(svg('polyline', { points: data.map(p => `${x(p.at)},${y(p.used_pct)}`).join(' '), class: className }));
    };
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      line(ideal, 'ideal');
      line(actual, 'actual');
      line(planner, 'planner');
      for (const point of actual) graph.append(svg('circle', { cx: x(point.at), cy: y(point.used_pct), r: 3.5, class: 'point' }));
      if (projected !== null && used !== null && reading && reset) line([{ at: reading.toISOString(), used_pct: used }, { at: reset.toISOString(), used_pct: projected }], 'projected');
      graph.append(svg('text', { x: 40, y: 153, class: 'axis-label' }, stamp(new Date(start).toISOString())), svg('text', { x: 492, y: 153, 'text-anchor': 'end', class: 'axis-label' }, reset ? `Reset ${stamp(reset.toISOString())}` : stamp(new Date(end).toISOString())));
      if (!actual.length) graph.append(svg('text', { x: 266, y: 91, 'text-anchor': 'middle', class: 'chart-empty' }, pool.source === 'estimate' ? 'Estimated reading only; no recorded series' : 'No recorded usage'));
    } else {
      graph.append(svg('text', { x: 266, y: 85, 'text-anchor': 'middle', class: 'chart-empty' }, 'Usage window unknown'));
    }
    return graph;
  }
  function renderPools(rows) {
    const target = document.getElementById('pools');
    if (!list(rows).length) { empty(target, 'Pool evidence unknown. Refresh the shared snapshot from the host.'); return; }
    target.replaceChildren(...rows.map(pool => {
      const article = el('article', pool.id === 'grok-ultra-weekly' ? 'pool shared' : 'pool');
      const header = el('div', 'pool-header'); const heading = el('div');
      heading.append(el('h3', '', names[pool.id] ?? text(pool.id)));
      heading.append(el('p', 'pool-subtitle', pool.id === 'grok-ultra-weekly' ? 'One shared limit for Grok Bot and Cursor' : pool.shared_with ? `Shares ${names[pool.shared_with] ?? text(pool.shared_with)}; no additional capacity` : `Reset ${stamp(pool.reset_at)}`));
      const used = el('div', 'pool-used', percent(pool.used_pct)); used.append(el('small', '', 'used')); header.append(heading, used);
      const facts = el('div', 'pool-facts'); facts.append(fact('Remaining', percent(pool.remaining_pct)), fact('Runway', hours(pool.runway_hours)), fact('Landing at reset', percent(pool.projected_pct)));
      const note = el('p', 'pool-note'); note.append(el('span', 'source', pool.source === 'manual' ? 'Manual reading' : pool.source === 'estimate' ? 'Estimate' : 'Unknown'));
      note.append(document.createTextNode(`${age(pool.age_seconds)}. Ideal now ${percent(pool.ideal_pct)}. `));
      note.append(document.createTextNode(number(pool.projected_pct) === null ? 'Projection unknown; two readings and a reset window are needed.' : `Projected from recorded pace; future usage is uncertain. Burn ${number(pool.burn_pct_per_hour) === null ? 'unknown' : pool.burn_pct_per_hour.toFixed(2) + '%/hour'}.`));
      if (list(pool.planner).length) note.append(document.createTextNode(' Mint line: planner forecast.'));
      article.append(header, chart(pool), facts, note); return article;
    }));
  }
  function renderAgents(rows) {
    const target = document.getElementById('agents');
    if (rows === null || rows === undefined) { empty(target, 'Current tasks unknown; the claim ledger could not be read.'); return; }
    if (!list(rows).length) { empty(target, 'No active claims in the readable ledger.'); return; }
    target.replaceChildren(...rows.map(agent => {
      const node = el('article', 'work-row'); const details = el('div');
      details.append(el('h3', 'row-title', text(agent.agent)), el('p', 'row-detail', text(agent.task)), el('p', 'row-detail', text(agent.repo)));
      node.append(details, el('p', 'row-meta', `Claim expires ${stamp(agent.expires_at)}`)); return node;
    }));
  }
  function renderRepos(rows) {
    const target = document.getElementById('repos');
    if (!list(rows).length) { empty(target, 'Repository evidence unknown.'); return; }
    target.replaceChildren(...rows.map(repo => {
      const node = el('article', 'repo'); const summary = el('div', 'repo-summary');
      summary.append(el('h3', '', text(repo.repo)), el('p', '', `${repo.open === null ? 'Open unknown' : `${list(repo.open).length} open`} / ${repo.merged === null ? 'Merged unknown' : `${list(repo.merged).length} merged`}${repo.complete === false ? ' / partial list' : ''}`)); node.append(summary);
      const prs = [...list(repo.open), ...list(repo.merged)];
      if (!prs.length) node.append(el('p', 'row-detail', repo.source === 'known' ? 'No pull requests in this snapshot.' : 'GitHub evidence unavailable.'));
      for (const pr of prs) {
        const row = el('div', 'pr-row'); const details = el('div'); const title = el('p', 'pr-title');
        // Construct from vetted identity; never accept a source-provided href.
        const validRepo = /^ashlrai\/[A-Za-z0-9._-]+$/.test(repo.repo);
        const link = validRepo && Number.isSafeInteger(pr.number) && pr.number > 0 ? el('a', '', `#${pr.number} ${text(pr.title)}`) : el('span', '', `#${text(String(pr.number ?? ''))} ${text(pr.title)}`);
        if (link.tagName === 'A') { link.href = `https://github.com/${repo.repo}/pull/${pr.number}`; link.rel = 'noreferrer'; }
        title.append(link); const status = el('p', 'pr-status', `${text(pr.state)} / CI ${text(pr.ci)}`);
        if (pr.ci === 'passed') status.classList.add('ci-pass'); if (pr.ci === 'failed') status.classList.add('ci-fail');
        details.append(title, status);
        const cost = list(pr.cost).length ? pr.cost.map(c => `${number(c.value) === null ? 'unknown' : c.value.toFixed(3)} ${text(c.unit)} (${names[c.pool] ?? text(c.pool)})`).join(', ') : 'Cost unknown';
        row.append(details, el('p', 'pr-cost', cost)); node.append(row);
      }
      return node;
    }));
  }
  function renderRouter(router) {
    const data = router && typeof router === 'object' ? router : {};
    document.getElementById('regret-summary').textContent = data.regret === null || data.regret === undefined ? 'Regret unknown' : `${list(data.regret).length} regret signals`;
    const target = document.getElementById('router');
    if (data.decisions === null || data.decisions === undefined) { empty(target, 'Router decisions unknown; the decision ledger could not be read.'); return; }
    if (!list(data.decisions).length) { empty(target, 'No decisions in the readable router ledger.'); return; }
    const regrets = list(data.regret);
    const regretUnknown = data.regret === null || data.regret === undefined;
    target.replaceChildren(...list(data.decisions).slice(-12).reverse().map(decision => {
      const node = el('article', 'route-row'); const details = el('div'); const chosen = decision.poolId ?? decision.pool;
      details.append(el('h3', 'row-title', `${text(decision.jobId ?? decision.job_id)} → ${names[chosen] ?? text(chosen)}`));
      const regret = regrets.find(r => (r.jobId ?? r.job_id) === (decision.jobId ?? decision.job_id));
      details.append(el('p', 'row-detail', `${text(decision.jobType ?? decision.job_type)} / ${text(decision.solver)}${decision.fallback === true ? ' fallback' : ''}${regret ? ` / posterior regret ${number(regret.regret) === null ? 'unknown' : regret.regret.toFixed(3)}; alternative ${names[regret.betterPool] ?? text(regret.betterPool)}` : regretUnknown ? ' / regret unknown' : ' / no matched regret signal'}`));
      node.append(details, el('p', 'row-meta', stamp(decision.ts ?? decision.at))); return node;
    }));
  }
  function renderBoard(board) {
    const target = document.getElementById('board');
    if (!board || board.state === 'unknown') { empty(target, 'Coordination board unknown; the host ledger could not be read.'); return; }
    const rows = [...list(board.proposals).map(p => ({ title: `Proposed for ${text(p.to)}`, body: p.task, detail: p.repo, at: p.at })), ...list(board.messages).map(m => ({ title: `${text(m.from)} to ${text(m.to)}`, body: m.body, detail: 'Message', at: m.at }))];
    if (!rows.length) { empty(target, 'No live messages or assignment proposals.'); return; }
    target.replaceChildren(...rows.slice(-20).reverse().map(item => { const node = el('article', 'board-row'); const details = el('div'); details.append(el('h3', 'row-title', item.title), el('p', 'row-detail', text(item.body)), el('p', 'row-detail', text(item.detail))); node.append(details, el('p', 'row-meta', stamp(item.at))); return node; }));
  }
  function render(snapshot) {
    if (!snapshot || snapshot.schema !== 'fleet.v1') throw new Error('Unsupported snapshot');
    const generated = date(snapshot.generated_at);
    const snapshotAge = generated ? Math.max(0, (Date.now() - generated.getTime()) / 1000) : null;
    document.getElementById('snapshot-time').textContent = `As of ${stamp(snapshot.generated_at)} / ${age(snapshotAge)}`;
    renderPools(snapshot.pools); renderAgents(snapshot.agents); renderRepos(snapshot.repos); renderRouter(snapshot.router); renderBoard(snapshot.coordination);
    return snapshotAge;
  }
  function clearPrivateEvidence() {
    for (const id of ['pools', 'agents', 'repos', 'router', 'board']) empty(document.getElementById(id), 'Sign in to view fleet evidence.');
    document.getElementById('snapshot-time').textContent = 'Snapshot unavailable while signed out';
    document.getElementById('regret-summary').textContent = 'Regret unknown';
  }
  let stopped = false; let timer; let pending = false;
  async function refresh() {
    if (pending || stopped) return;
    pending = true;
    const connection = document.getElementById('connection');
    try {
      const response = await fetch('/api/fleet', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: window.AbortSignal.timeout(15000) });
      if (response.status === 401 || response.status === 403) {
        stopped = true; window.clearTimeout(timer); clearPrivateEvidence(); document.getElementById('auth').hidden = false;
        connection.dataset.state = 'auth'; connection.textContent = 'Remote authentication required. Refresh paused.'; return;
      }
      if (!response.ok) throw new Error('Snapshot unavailable');
      const snapshotAge = render(await response.json());
      if (snapshotAge === null || snapshotAge * 1000 > POLL_MS * 2) {
        connection.dataset.state = 'stale'; connection.textContent = `Shared snapshot available, ${age(snapshotAge)}. Refresh the snapshot from the host for current evidence.`;
      } else {
        connection.dataset.state = 'live'; connection.textContent = 'Shared snapshot connected. Read-only; refreshes every 30 seconds.';
      }
    } catch {
      connection.dataset.state = 'error'; connection.textContent = 'Snapshot unavailable. Last displayed evidence may be stale. Retrying in 30 seconds.';
    } finally { pending = false; if (!stopped) timer = window.setTimeout(refresh, POLL_MS); }
  }
  window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped) { window.clearTimeout(timer); void refresh(); } });
  void refresh();
})();
