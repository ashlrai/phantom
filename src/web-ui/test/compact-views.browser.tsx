// Real CSS/layout coverage; run with node scripts/test-compact-views.mjs.
import { createRoot } from 'react-dom/client';
import { GoalsPane } from '../routes/verse/goals-pane/GoalsPane.js';
import { GoalsView } from '../routes/goals/GoalsView.js';
import { FeedSection } from '../routes/verse/feed/FeedSection.js';
import { FleetUsagePane } from '../routes/verse/fleet-usage/FleetUsagePane.js';
import { WorklogView } from '../routes/work/worklog/WorklogView.js';
import type { PaneProps } from '../routes/verse/panes/pane-registry.js';
import '../design/global.css';

const long = 'LongRecordedName'.repeat(10), at = new Date().toISOString();
const fixtures: Record<string, unknown> = {
  '/api/goals': [{ id: 'g1', objective: long, status: 'active', progress: { fractionDone: 0.5, counts: {}, nextActionableId: long }, milestones: [{ title: long, status: 'pending', order: 0 }] }],
  '/api/vision/mission': { state: 'steady', sources: {} },
  '/api/feed': { schema: 'phantom.feed.v2', version: 2, more: false, items: [{ id: 'merge:1', kind: 'merged', at, text: long, href: 'https://github.com/ashlrai/phantom/pull/1', repo: null, job: null, count: 1 }], sources: { jobs: 'available', events: 'available', leader: 'available', merges: 'available', releases: 'available', main: 'available' } },
  '/api/verse/accounts': { accounts: [{ id: 'c1', label: long, provider: 'claude', state: 'observed', authentication: 'signed-in', reconnectCommand: 'ashlr auth login claude', windows: [{ id: 'weekly', label: long, usedPercent: 58, measured: true, resetDescription: long }] }] },
  '/api/verse/fleet/runs': { v: 1, generatedAt: at, sources: {}, lanes: [{ lane: long, running: 1, target: 2, tokensLastHour: 500 }] },
  '/api/worklog': { schema: 'worklog.v3', hours: 6, sources: {jobs:{state:'ok'},events:{state:'ok'},leader:{state:'ok'}}, rows: [{at, kind:'merged', job:long, repo:long, lane:long, text:'Merged work '+long, url:'https://github.com/ashlrai/phantom/pull/1', count:1}], malformedLines: 1, entries: [{ kind: 'merged', at, job: long, repo: long, lane: long, model: long, url: 'https://github.com/ashlrai/phantom/pull/1', openToMergeSeconds: 90 }] },
};
const views = { Goals: <GoalsPane />, 'Goals page': <GoalsView />, Feed: <FeedSection />, Usage: <FleetUsagePane {...{ visible: true } as PaneProps} />, 'Work log': <WorklogView />, 'Feed actions': <FeedSection /> };
const paths = ['/api/goals', '/api/goals', '/api/feed', '/api/verse/accounts', '/api/worklog', '/api/feed'];
const ready = ['[role="progressbar"]', 'li', 'ol a', '[role="meter"]', 'tbody tr', 'ol h3'];
const stacks = ['form', 'dl', 'ol li > div', '[aria-label="Provider usage"] > li', 'tbody tr', 'ol li header'];
const name = new URLSearchParams(location.search).get('view') as keyof typeof views | null;
const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const frame = () => new Promise<void>(resolve => setTimeout(resolve, 50));

if (!name) {
  window.addEventListener('message', event => {
    if (![...document.querySelectorAll('iframe')].some(iframe => iframe.contentWindow === event.source)) return;
    const result = document.createElement('pre'); result.textContent = String(event.data); document.body.append(result);
  });
  for (const view of Object.keys(views)) {
    const iframe = document.createElement('iframe'); iframe.width = '390'; iframe.height = '844';
    iframe.style.border = '0'; iframe.src = `?view=${encodeURIComponent(view)}`; document.body.append(iframe);
  }
} else {
  if (name === 'Feed actions') { delete fixtures['/api/feed']; fixtures['/api/verse/fleet/runs'] = { mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: long, mergedAt: at }] } }; }
  const requests: string[] = [];
  window.fetch = async input => {
    const path = new URL(String(input), location.href).pathname; requests.push(path);
    return Response.json(fixtures[path] ?? {}, { status: path in fixtures ? 200 : 404 });
  };
  document.documentElement.dataset.consoleLayout = 'compact';
  document.body.style.cssText = 'margin:0;padding:12px';
  const root = document.createElement('div'); document.body.append(root); createRoot(root).render(views[name]);
  void (async () => {
    const index = Object.keys(views).indexOf(name);
    for (let i = 0; i < 120 && !root.querySelector(ready[index]!); i++) await frame();
    assert(!!root.querySelector(ready[index]!), `${name}: populated view did not render`);
    if (name === 'Goals') [...root.querySelectorAll('button')].find(b => b.textContent === 'Steer')!.click();
    if (name === 'Feed actions') root.querySelector('summary')!.click();
    if (name === 'Work log') { root.querySelector('summary')!.click(); root.querySelector('tbody button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    await frame(); await document.fonts.ready;
    assert(innerWidth === 390, `${name}: viewport is ${innerWidth}`);
    assert(requests.includes(paths[index]!), `${name}: existing data endpoint was not used`);
    assert(document.documentElement.scrollWidth <= 390, `${name}: horizontal page scroll`);
    for (const stack of root.querySelectorAll(stacks[index]!)) {
      const boxes = [...stack.children].map(el => el.getBoundingClientRect());
      assert(boxes.every((box, i) => i === 0 || box.top >= boxes[i - 1]!.bottom - 1), `${name}: content did not stack`);
    }
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      const box = el.getBoundingClientRect(); if (!box.width || !box.height || el.closest('thead')) continue;
      assert(box.left >= 0 && box.right <= 390.5 && el.scrollWidth <= el.clientWidth + 1, `${name}: overflow in ${el.tagName}.${el.className}`);
      if (el.matches('button, a[href], input, select, summary')) assert(box.width >= 44 && box.height >= 44, `${name}: small target ${el.textContent}`);
      if (el.matches('td')) assert(!!el.dataset.label, `${name}: missing stacked cell label`);
    }
    if (name === 'Work log') assert(root.querySelectorAll('select')[1]!.value === long, 'Lane filter did not respond');
    parent.postMessage(`PASS ${name} at 390px`, '*');
  })().catch(error => parent.postMessage(`FAIL ${String(error)}`, '*'));
}
