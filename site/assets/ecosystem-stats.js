/* Phantom ecosystem stats: live data branch first, committed snapshot as fallback. Never shows a fake 0. */
/* global performance, requestAnimationFrame, fetch */
(() => {
  const band = document.getElementById('eco-stats');
  if (!band) return;
  const sources = [
    'https://raw.githubusercontent.com/ashlrai/phantom/ecosystem-stats/ecosystem.json',
    '/stats/ecosystem.json',
  ];
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
  const valid = (d) => d && d.schemaVersion === 1 && d.totals
    && Number.isInteger(d.totals.stars) && Number.isInteger(d.totals.commits) && Array.isArray(d.repos);
  const count = (el, to) => {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  (async () => {
    for (const url of sources) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const d = await res.json();
        if (!valid(d)) continue;
        count(band.querySelector('[data-eco="stars"]'), d.totals.stars);
        count(band.querySelector('[data-eco="commits"]'), d.totals.commits);
        band.querySelector('[data-eco="repos"]').textContent = fmt(d.totals.repos);
        const asOf = band.querySelector('[data-eco="asof"]');
        asOf.textContent = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(d.asOf));
        asOf.setAttribute('datetime', d.asOf);
        const list = band.querySelector('[data-eco="list"]');
        list.replaceChildren(...[...d.repos].sort((a, b) => b.stars - a.stars || b.commits - a.commits).map((r) => {
          const a = document.createElement('a');
          a.href = r.url; a.className = 'eco-chip';
          a.title = `${r.repo}: ${fmt(r.stars)} stars, ${fmt(r.commits)} commits`;
          a.textContent = r.repo;
          const s = document.createElement('span'); s.textContent = `★ ${fmt(r.stars)}`;
          a.append(s);
          return a;
        }));
        band.dataset.state = 'ready';
        return;
      } catch { /* try next source */ }
    }
    band.dataset.state = 'unavailable';
  })();
})();
