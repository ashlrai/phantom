import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../src/core/web/public/fleet/${name}`, import.meta.url)), 'utf8');
const html = asset('index.html');
const script = asset('fleet.js');
const mounted: JSDOM[] = [];
afterEach(() => { for (const dom of mounted) dom.window.close(); mounted.length = 0; });
const NOW = '2026-10-26T12:00:00.000Z';
function snapshot() {
  return {
    schema: 'fleet.v1', generated_at: NOW,
    pools: [{ id: 'grok-ultra-weekly', shared_with: null, source: 'manual', used_pct: 40, remaining_pct: 60, age_seconds: 7200,
      reset_at: '2026-11-02T01:21:00.000Z', window_start: '2026-10-26T00:21:00.000Z', reading_at: NOW,
      runway_hours: 30, burn_pct_per_hour: 2, projected_pct: 109, ideal_pct: 7,
      actual: [{ at: '2026-10-26T02:00:00.000Z', used_pct: 20 }, { at: NOW, used_pct: 40 }],
      ideal: [{ at: '2026-10-26T00:21:00.000Z', used_pct: 0 }, { at: '2026-11-02T01:21:00.000Z', used_pct: 100 }], planner: [] },
    { id: 'cursor', shared_with: 'grok-ultra-weekly', source: 'unknown', used_pct: null, remaining_pct: null, actual: [], ideal: [], planner: [] }],
    agents: [{ agent: 'codex-cmp', task: 'Fix pool accounting', repo: 'ashlrai/phantom', expires_at: NOW }],
    repos: [{ repo: 'ashlrai/phantom', source: 'known', complete: true, open: [{ number: 939, title: 'Coding fleet', state: 'open', ci: 'pending', cost: null }], merged: [{ number: 938, title: 'Pool scheduler', state: 'merged', ci: 'passed', cost: [{ pool: 'codex-cmp', value: 2, unit: 'pool-unit' }] }] }],
    router: { decisions: [{ jobId: 'pool-accounting', jobType: 'coding', poolId: 'codex-cmp', solver: 'highs', ts: NOW }], regret: [{ jobId: 'pool-accounting', regret: 0.2, betterPool: 'local' }] },
    coordination: { state: 'known', proposals: [{ to: 'codex-cmp', task: 'Review fleet', repo: 'ashlrai/phantom', at: NOW }], messages: [{ from: 'cursor', to: 'codex-cmp', body: 'Review ready', at: NOW }] },
  };
}
async function mount(responses: { status: number; body?: unknown }[], nowMs = Date.parse(NOW)) {
  const dom = new JSDOM(html, { url: 'https://phone.example.com/fleet/', runScripts: 'outside-only' });
  mounted.push(dom);
  Object.defineProperty(dom.window.Date, 'now', { value: () => nowMs });
  const tasks: (() => void)[] = [];
  const request = vi.fn(async () => {
    const response = responses.shift() ?? { status: 503 };
    return { status: response.status, ok: response.status === 200, json: async () => response.body };
  });
  Object.defineProperty(dom.window, 'fetch', { value: request });
  Object.defineProperty(dom.window.AbortSignal, 'timeout', { value: () => new dom.window.AbortController().signal });
  Object.defineProperty(dom.window, 'setTimeout', { value: (callback: () => void, ms: number) => { expect(ms).toBe(30000); tasks.push(callback); return tasks.length; } });
  Object.defineProperty(dom.window, 'clearTimeout', { value: vi.fn() });
  dom.window.eval(script);
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  await flush();
  return { dom, document: dom.window.document, request, tasks, flush };
}

describe('fleet phone dashboard', () => {
  it('renders readings, per-pool curves, unknowns, tasks, PR CI/cost, and proposals from the versioned snapshot', async () => {
    const f = await mount([{ status: 200, body: snapshot() }]);
    expect(f.request).toHaveBeenCalledWith('/api/fleet', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    const shared = f.document.querySelector('.pool.shared')!;
    expect(shared.textContent).toContain('40%');
    expect(shared.textContent).toContain('Manual reading');
    expect(shared.textContent).toContain('2.0h old');
    expect(shared.textContent).toContain('109%');
    expect(shared.querySelector('polyline.actual')).not.toBeNull();
    expect(shared.querySelector('polyline.ideal')).not.toBeNull();
    expect(shared.querySelector('polyline.projected')).not.toBeNull();
    expect(shared.querySelector('svg title')?.textContent).toContain('projected at reset 109%');
    const cursor = f.document.querySelectorAll('.pool')[1];
    expect(cursor.textContent).toContain('no additional capacity');
    expect(cursor.querySelector('.pool-used')?.textContent).toBe('unknownused');
    expect(cursor.querySelector('polyline.actual')).toBeNull();
    expect(f.document.getElementById('agents')?.textContent).toContain('Fix pool accounting');
    expect(f.document.getElementById('repos')?.textContent).toContain('CI pending');
    expect(f.document.getElementById('repos')?.textContent).toContain('Cost unknown');
    expect(f.document.getElementById('repos')?.textContent).toContain('2.000 pool-unit');
    expect(f.document.getElementById('router')?.textContent).toContain('posterior regret 0.200');
    expect(f.document.getElementById('board')?.textContent).toContain('Proposed for codex-cmp');
    expect(f.tasks).toHaveLength(1);
  });

  it('inserts hostile source text as text and constructs GitHub URLs from PR identity', async () => {
    const data = snapshot();
    const attack = '<img src=x onerror="window.exposed=true">';
    data.repos[0].open[0].title = attack;
    Object.assign(data.repos[0].open[0], { url: 'javascript:alert(1)' });
    data.agents[0].task = attack;
    data.coordination.messages[0].body = attack;
    const f = await mount([{ status: 200, body: data }]);
    expect(f.document.querySelector('img')).toBeNull();
    expect(f.document.getElementById('agents')?.textContent).toContain(attack);
    expect(f.document.querySelector('.pr-title a')?.getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/939');
    expect(f.document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(f.document.querySelector('form')).toBeNull();
  });

  it.each([401, 403])('stops refresh after authentication expires (%s)', async status => {
    const f = await mount([{ status, body: { error: 'private response' } }]);
    expect(f.document.getElementById('auth')?.hidden).toBe(false);
    expect(f.document.getElementById('connection')?.textContent).toContain('Refresh paused');
    expect(f.tasks).toHaveLength(0);
    f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
    await f.flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.document.getElementById('auth')?.querySelector('a')?.getAttribute('href')).toBe('/verse/m/');
    expect(f.document.body.textContent).not.toContain('private response');
  });

  it.each([401, 403])('clears previously displayed private evidence when authentication expires (%s)', async status => {
    const f = await mount([{ status: 200, body: snapshot() }, { status }]);
    expect(f.document.getElementById('agents')?.textContent).toContain('Fix pool accounting');
    expect(f.document.querySelector('.pool')).not.toBeNull();
    f.tasks.shift()!(); await f.flush();
    expect(f.document.getElementById('auth')?.hidden).toBe(false);
    expect(f.document.getElementById('connection')?.textContent).toContain('Refresh paused');
    expect(f.document.querySelector('.pool')).toBeNull();
    for (const id of ['pools', 'agents', 'repos', 'router', 'board']) {
      expect(f.document.getElementById(id)?.textContent).toBe('Sign in to view fleet evidence.');
    }
    expect(f.document.getElementById('snapshot-time')?.textContent).toBe('Snapshot unavailable while signed out');
    expect(f.document.getElementById('regret-summary')?.textContent).toBe('Regret unknown');
    expect(f.document.body.textContent).not.toContain('Fix pool accounting');
    expect(f.document.querySelector('.pr-title a')).toBeNull();
    expect(f.tasks).toHaveLength(0);
  });

  it('preserves unknown regret on individual router decisions', async () => {
    const data = snapshot();
    const f = await mount([{ status: 200, body: { ...data, router: { decisions: data.router.decisions, regret: null } } }]);
    expect(f.document.getElementById('regret-summary')?.textContent).toBe('Regret unknown');
    expect(f.document.getElementById('router')?.textContent).toContain('regret unknown');
    expect(f.document.getElementById('router')?.textContent).not.toContain('no matched regret signal');
  });

  it('shows snapshot age and marks unchanged evidence stale after two polling intervals', async () => {
    const f = await mount([{ status: 200, body: snapshot() }], Date.parse(NOW) + 61_000);
    expect(f.document.getElementById('snapshot-time')?.textContent).toContain('1m old');
    expect(f.document.getElementById('connection')?.dataset.state).toBe('stale');
    expect(f.document.getElementById('connection')?.textContent).toContain('Refresh the snapshot from the host');
    expect(f.document.getElementById('agents')?.textContent).toContain('Fix pool accounting');
    expect(f.tasks).toHaveLength(1);
  });

  it('labels a recent snapshot connected and displays its age', async () => {
    const f = await mount([{ status: 200, body: snapshot() }], Date.parse(NOW) + 60_000);
    expect(f.document.getElementById('snapshot-time')?.textContent).toContain('1m old');
    expect(f.document.getElementById('connection')?.dataset.state).toBe('live');
  });

  it('keeps previous evidence visible and marks it stale on a failed refresh', async () => {
    const f = await mount([{ status: 200, body: snapshot() }, { status: 503, body: { secret: 'never-render-this' } }]);
    f.tasks.shift()!(); await f.flush();
    expect(f.document.getElementById('connection')?.textContent).toContain('may be stale');
    expect(f.document.getElementById('agents')?.textContent).toContain('Fix pool accounting');
    expect(f.document.body.textContent).not.toContain('never-render-this');
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported schema and leaves absent evidence explicitly unknown', async () => {
    const f = await mount([{ status: 200, body: { schema: 'fleet.v99', pools: snapshot().pools } }]);
    expect(f.document.querySelector('.pool')).toBeNull();
    expect(f.document.getElementById('connection')?.textContent).toContain('Snapshot unavailable');
    expect(f.document.getElementById('agents')?.textContent).toContain('unknown');
  });

  it('uses local assets and an accessible mobile layout', () => {
    const dom = new JSDOM(html); mounted.push(dom);
    expect(dom.window.document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('width=device-width');
    expect(dom.window.document.querySelector('script[src]')?.getAttribute('src')).toBe('/fleet/fleet.js');
    expect(dom.window.document.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('/fleet/fleet.css');
    expect(dom.window.document.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main');
    expect(asset('fleet.css')).toContain('@media(max-width:600px)');
    expect(asset('fleet.css')).toContain('prefers-reduced-motion');
  });
});
