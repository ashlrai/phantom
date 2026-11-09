#!/usr/bin/env node
/**
 * scripts/measure-desktop-perf.mjs — repeatable cold-start and steady-state
 * render measurement for the Phantom desktop window (the /verse/ console).
 *
 * The desktop app is a Tauri window around `http://127.0.0.1:7777/verse/`; the
 * page receives its tokens as `window.__ASHLR_TOKENS__` from the shell's
 * initialization script. This script reproduces exactly that: it starts the
 * real `phm verse` server on a scratch HOME, opens the console in a fresh
 * headless Chrome profile, injects the tokens the same way, and measures.
 * Chromium stands in for the system webview: absolute numbers differ from the
 * packaged app, but a before/after on the same machine is comparable.
 *
 * Per run (cold = brand-new browser context, empty HTTP cache):
 *   cold start    navigation start → first meaningful render: the first frame
 *                 where `main#main-content[data-section=<section>]` is mounted,
 *                 holds text, and no loading status / aria-busy node is left
 *                 inside it. Also: first-contentful-paint, long tasks and
 *                 script/layout time before that frame, API requests and JS
 *                 bytes fetched before it (the startup IPC).
 *   warm-up       after that render the shell warms the other surfaces; the run waits for
 *                 1.5 s without a long task or new request, and reports that burst (long
 *                 tasks, files) and how long it lasted.
 *   steady state  `--steady-ms` of the page left alone once the warm-up is quiet:
 *                 requestAnimationFrame interval (p50/p95/max), long tasks
 *                 (count, total, worst) and main-thread busy time per second
 *                 from CDP Performance.getMetrics (TaskDuration, ScriptDuration,
 *                 LayoutDuration, RecalcStyleDuration).
 *
 * The server's data is whatever the scratch HOME holds (empty by default), so
 * this measures the app's own cost, not a particular fleet's payload. Pass
 * `--home DIR` to measure against a populated HOME.
 *
 * Usage:
 *   node scripts/measure-desktop-perf.mjs                  # 5 cold runs, default landing section
 *   node scripts/measure-desktop-perf.mjs --section command --runs 7 --steady-ms 15000
 *   node scripts/measure-desktop-perf.mjs --json --out perf.json
 *   node scripts/measure-desktop-perf.mjs --chrome /path/to/chrome
 *   node scripts/measure-desktop-perf.mjs --chrome-no-sandbox   # only where Chrome's own sandbox cannot start
 *
 * Needs `npm run build` first (the server serves dist/). No dependencies: it
 * speaks the DevTools protocol over Node's built-in WebSocket.
 *
 * Exit: 0 measured, 2 setup error (no build, no Chrome, server/page failure).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Quiet period that ends the post-render warm-up, and the longest wait for it. */
const QUIET_MS = 1500;
const SETTLE_MAX_MS = 30_000;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** Pure: percentile (nearest-rank) of numbers; null for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/** Pure: median of numbers; null for an empty list. */
export const median = (values) => percentile(values, 50);

const round = (n, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(digits)));

/** Pure: summarise rAF timestamps (ms) into frame-interval statistics. */
export function summarizeFrames(timestamps) {
  const deltas = [];
  for (let i = 1; i < timestamps.length; i++) deltas.push(timestamps[i] - timestamps[i - 1]);
  return {
    frames: deltas.length,
    p50: round(percentile(deltas, 50)),
    p95: round(percentile(deltas, 95)),
    max: round(deltas.length ? Math.max(...deltas) : null),
    over50ms: deltas.filter((d) => d > 50).length,
  };
}

/** Pure: summarise long-task entries ({ startTime, duration }). */
export function summarizeLongTasks(entries) {
  const durations = entries.map((e) => e.duration);
  return {
    count: entries.length,
    totalMs: round(durations.reduce((a, b) => a + b, 0)),
    maxMs: round(durations.length ? Math.max(...durations) : 0),
  };
}

/** Pure: per-metric delta of two CDP Performance.getMetrics snapshots (name → value). */
export function metricsDelta(before, after) {
  const out = {};
  for (const key of Object.keys(after)) if (key in before) out[key] = after[key] - before[key];
  return out;
}

/** Pure: collapse a list of per-run result objects into median-per-metric. */
export function medianOfRuns(runs, pick) {
  return round(median(runs.map(pick).filter((v) => typeof v === 'number')));
}

/**
 * The in-page probe, installed before any page script runs. Kept as a string
 * so it is injected verbatim (Page.addScriptToEvaluateOnNewDocument) and
 * carries no module scope. `__PERF_SECTION__` is replaced per run.
 */
export function probeSource(section, tokens) {
  return `(() => {
  window.__ASHLR_TOKENS__ = ${JSON.stringify(tokens)};
  const section = ${JSON.stringify(section)};
  const state = window.__perf = { longTasks: [], frames: [], fmr: null, fcp: null, fmrLongTasks: 0, recording: false, mutations: {}, mutationCount: 0 };
  try {
    // What the page rewrites while idle: which elements (and attributes) mutate during the steady window.
    new MutationObserver((records) => {
      if (!state.recording) return;
      for (const m of records) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const cls = t && typeof t.className === 'string' ? t.className.split(' ')[0] : '';
        const key = (t ? t.tagName.toLowerCase() + (cls ? '.' + cls : '') : '?') + ' ' + m.type + (m.attributeName ? ':' + m.attributeName : '');
        state.mutations[key] = (state.mutations[key] || 0) + 1;
        state.mutationCount++;
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (_) {}
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) state.longTasks.push({ startTime: e.startTime, duration: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') state.fcp = e.startTime; })
      .observe({ type: 'paint', buffered: true });
  } catch (_) {}
  const meaningful = () => {
    const main = document.querySelector('main#main-content[data-section="' + section + '"]');
    if (!main || !(main.textContent || '').trim()) return false;
    if (main.querySelector('[aria-busy="true"]')) return false;
    for (const s of main.querySelectorAll('[role="status"]')) if (/loading|checking|connecting/i.test(s.textContent || '')) return false;
    return true;
  };
  const tick = (t) => {
    if (state.fmr === null && meaningful()) {
      state.fmr = t;
      state.fmrLongTasks = state.longTasks.length;
    }
    if (state.recording) state.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}

function parseArgs(argv) {
  const opts = { runs: 5, steadyMs: 10_000, settleMs: 1_000, section: null, json: false, out: null, chrome: null, home: null, label: null, quiet: false, noSandbox: false, profile: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (name) => {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number`);
      return n;
    };
    if (a === '--runs') opts.runs = Math.floor(num(a));
    else if (a === '--steady-ms') opts.steadyMs = num(a);
    else if (a === '--settle-ms') opts.settleMs = num(a);
    else if (a === '--section') opts.section = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--chrome') opts.chrome = argv[++i];
    else if (a === '--home') opts.home = argv[++i];
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--chrome-no-sandbox') opts.noSandbox = true;
    else if (a === '--profile') opts.profile = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/** Starts `phm verse` on a scratch HOME; resolves { url, readToken, token, stop }. */
async function startServer(home) {
  const port = await freePort();
  const env = { ...process.env, HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' };
  const child = spawn(process.execPath, [join(repoRoot, 'bin/ashlr'), 'verse', '--no-open', '--json', '--no-accounts', '--port', String(port)], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const info = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('phm verse did not print its startup record in 60s')), 60_000);
    child.once('exit', (code) => { clearTimeout(timer); rej(new Error(`phm verse exited early (code ${code})`)); });
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.startsWith('{') && l.includes('"readToken"'));
      if (line) { clearTimeout(timer); try { res(JSON.parse(line)); } catch (e) { rej(e); } }
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    readToken: info.readToken,
    token: info.token ?? null,
    stop: () => new Promise((res) => { child.once('exit', () => res()); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }),
  };
}

/** Minimal CDP client over a single WebSocket (browser endpoint, flattened sessions). */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true }); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; }
  close() { this.ws.close(); }
}

async function launchChrome(chromePath, noSandbox) {
  const profile = mkdtempSync(join(tmpdir(), 'phm-perf-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--mute-audio', '--window-size=1280,820', 'about:blank',
    // Only for hosts whose own sandbox forbids Chrome's (CI containers); the browser loads nothing but the local server.
    ...(noSandbox ? ['--no-sandbox', '--disable-crash-reporter'] : []),
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('Chrome did not open its DevTools port in 20s'); }
    await sleep(100);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  return {
    cdp,
    close: async () => {
      try { cdp.close(); } catch { /* already closed */ }
      child.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** Pure: top self-time call frames of a CDP CPU profile, as [{ ms, fn, url, line }]. */
export function topSelfTime(profile, limit = 15) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
  const agg = new Map();
  for (const [id, us] of self) {
    const cf = byId.get(id)?.callFrame;
    if (!cf) continue;
    const key = `${cf.functionName || '(anonymous)'}|${cf.url}|${cf.lineNumber}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  return [...agg].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, us]) => {
    const [fn, url, line] = key.split('|');
    return { ms: round(us / 1000), fn, url: url.replace(/^https?:\/\/[^/]+/, ''), line: Number(line) + 1 };
  });
}

/** Pure: self time per script file of a CDP CPU profile, [{ ms, url }] (JS only; natives bucketed by name). */
export function selfTimeByFile(profile, limit = 12) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const agg = new Map();
  profile.samples.forEach((id, i) => {
    const cf = byId.get(id)?.callFrame;
    if (!cf) return;
    const key = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, '') : cf.functionName;
    agg.set(key, (agg.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  return [...agg].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([url, us]) => ({ ms: round(us / 1000), url }));
}

/** Pure: top inclusive-time frames (a frame's own time plus its callees'), as [{ ms, fn, url, line }]. */
export function topInclusive(profile, limit = 20) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  profile.samples.forEach((id, i) => {
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const cf = byId.get(cur)?.callFrame;
      if (!cf || !cf.url) continue;
      const key = `${cf.functionName || '(anonymous)'}|${cf.url}|${cf.lineNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incl.set(key, (incl.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
  });
  return [...incl].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, us]) => {
    const [fn, url, line] = key.split('|');
    return { ms: round(us / 1000), fn, url: url.replace(/^https?:\/\/[^/]+/, ''), line: Number(line) + 1 };
  });
}

/** One cold run in its own browser context (empty cache, no storage). */
async function measureRun(cdp, server, opts, section) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1280, height: 820 });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);
  const requests = new Map();
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const { method, params } = msg;
    if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { url: params.request.url, t: params.timestamp, bytes: 0, type: params.type });
    else if (method === 'Network.loadingFinished') { const r = requests.get(params.requestId); if (r) { r.bytes = params.encodedDataLength; r.end = params.timestamp; } }
  });
  try {
    await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: false });
    await call('Performance.enable');
    await call('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (section !== 'default') {
      // Pre-seed the section the shell reopens (verse-ui-store V3 key) before any page script runs.
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('ashlr.verse.ui.v3', JSON.stringify({ section: ${JSON.stringify(section)} })); } catch (_) {}` });
    }
    await call('Page.addScriptToEvaluateOnNewDocument', { source: probeSource(section === 'default' ? await defaultSection(server) : section, { readToken: server.readToken, token: server.token }) });
    if (opts.profile) { await call('Profiler.enable'); await call('Profiler.setSamplingInterval', { interval: 500 }); await call('Profiler.start'); }
    const navStart = Date.now();
    const nav = await call('Page.navigate', { url: `${server.url}/verse/` });
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    const evalJs = async (expression) => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page evaluation failed: ${r.exceptionDetails.text}`);
      return r.result.value;
    };
    // Wait for the first meaningful render (bounded).
    const deadline = Date.now() + 30_000;
    let fmr = null;
    while (Date.now() < deadline) {
      fmr = await evalJs('window.__perf && window.__perf.fmr');
      if (typeof fmr === 'number') break;
      await sleep(50);
    }
    if (typeof fmr !== 'number') throw new Error(`no meaningful render for section "${section}" within 30s (is the build current? run npm run build)`);
    const cold = await evalJs(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const p = window.__perf;
      const res = performance.getEntriesByType('resource').filter((r) => r.startTime <= p.fmr);
      const api = res.filter((r) => r.name.includes('/api/'));
      const js = res.filter((r) => /\\.m?js(\\?|$)/.test(r.name));
      return {
        fmrMs: p.fmr, fcpMs: p.fcp, domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
        longTasksBeforeFmr: p.fmrLongTasks,
        longTaskMsBeforeFmr: p.longTasks.slice(0, p.fmrLongTasks).reduce((a, e) => a + e.duration, 0),
        apiRequestsBeforeFmr: api.length, jsRequestsBeforeFmr: js.length,
        jsBytesBeforeFmr: js.reduce((a, r) => a + (r.encodedBodySize || 0), 0),
        // Where the time went: the last resources to finish before the render, and when the app's own marks fired.
        jsFilesBeforeFmr: js.map((r) => r.name.replace(/^https?:\\/\\/[^/]+\\/next\\/assets\\//, '').replace(/-[A-Za-z0-9_-]{8}\\.m?js$/, '')),
        apiTimeline: api.map((r) => ({ url: r.name.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 70), start: Math.round(r.startTime), end: Math.round(r.responseEnd) })),
        waterfall: res.sort((a, b) => a.startTime - b.startTime).map((r) => [Math.round(r.startTime), Math.round(r.responseEnd), r.name.replace(/^https?:\\/\\/[^/]+\\/(next\\/assets\\/)?/, '').replace(/-[A-Za-z0-9_-]{8}\\.m?js$/, '')]),
        lastResources: res.sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 6).map((r) => ({ url: r.name.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 90), start: Math.round(r.startTime), end: Math.round(r.responseEnd) })),
      };
    })()`);
    cold.wallMs = Date.now() - navStart;
    const coldProfile = opts.profile ? (await call('Profiler.stop')).profile : null;
    // The shell warms every other surface after first paint (shell/warmup.ts). Wait for that burst to
    // finish (no long task and no new resource for QUIET_MS, bounded) so steady state is steady, and
    // report the burst itself: those long tasks block input in the first seconds after launch.
    if (opts.profile) await call('Profiler.start');
    const settleStart = Date.now();
    const ltAtFmr = await evalJs('window.__perf.longTasks.length');
    let lastActivity = Date.now();
    let seen = await evalJs('[window.__perf.longTasks.length, performance.getEntriesByType("resource").length].join()');
    while (Date.now() - settleStart < SETTLE_MAX_MS && (Date.now() - lastActivity < QUIET_MS || Date.now() - settleStart < opts.settleMs)) {
      await sleep(250);
      const now = await evalJs('[window.__perf.longTasks.length, performance.getEntriesByType("resource").length].join()');
      if (now !== seen) { seen = now; lastActivity = Date.now(); }
    }
    const burst = await evalJs(`(() => { const t = window.__perf.longTasks.slice(${ltAtFmr}); return { count: t.length, totalMs: t.reduce((a, e) => a + e.duration, 0), maxMs: t.reduce((m, e) => Math.max(m, e.duration), 0), resources: performance.getEntriesByType('resource').filter((r) => r.startTime > window.__perf.fmr).length }; })()`);
    const warmupProfile = opts.profile ? (await call('Profiler.stop')).profile : null;
    const warmup = { settledAfterMs: Date.now() - settleStart, longTasks: burst.count, longTaskMs: round(burst.totalMs), longTaskMaxMs: round(burst.maxMs), resources: burst.resources };
    const metricsOf = async () => Object.fromEntries((await call('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const m0 = await metricsOf();
    const lt0 = await evalJs('window.__perf.longTasks.length');
    if (opts.profile) await call('Profiler.start');
    await evalJs('window.__perf.frames.length = 0; window.__perf.mutations = {}; window.__perf.mutationCount = 0; window.__perf.recording = true; true');
    await sleep(opts.steadyMs);
    const profile = opts.profile ? (await call('Profiler.stop')).profile : null;
    await evalJs('window.__perf.recording = false; true');
    const m1 = await metricsOf();
    const animations = await evalJs(`(() => { const all = document.getAnimations().filter((a) => a.playState === 'running'); const by = {}; for (const a of all) { const t = a.effect && a.effect.target; const k = (a.animationName || a.constructor.name) + ' on ' + (t ? t.tagName.toLowerCase() + (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '') : '?'); by[k] = (by[k] || 0) + 1; } return { running: all.length, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8) }; })()`);
    const mutations = await evalJs('({ total: window.__perf.mutationCount, top: Object.entries(window.__perf.mutations).sort((a, b) => b[1] - a[1]).slice(0, 8) })');
    const frames = await evalJs('window.__perf.frames');
    const longTasks = await evalJs(`window.__perf.longTasks.slice(${lt0})`);
    const d = metricsDelta(m0, m1);
    const seconds = opts.steadyMs / 1000;
    const heap = m1.JSHeapUsedSize ?? null;
    const steady = {
      frame: summarizeFrames(frames),
      longTasks: summarizeLongTasks(longTasks),
      mainThreadBusyMsPerSec: round(((d.TaskDuration ?? 0) * 1000) / seconds),
      scriptMsPerSec: round(((d.ScriptDuration ?? 0) * 1000) / seconds),
      layoutMsPerSec: round(((d.LayoutDuration ?? 0) * 1000) / seconds),
      styleMsPerSec: round(((d.RecalcStyleDuration ?? 0) * 1000) / seconds),
      layoutsPerSec: round((d.LayoutCount ?? 0) / seconds),
      runningAnimations: animations,
      domMutations: mutations,
      domNodes: m1.Nodes ?? null,
      jsHeapMb: heap === null ? null : round(heap / 1048576),
    };
    const apiDuringSteady = [...requests.values()].filter((r) => r.url.includes('/api/')).length;
    // Whole-run profile for DevTools (Performance ▸ Load profile): <out>.{cold,warmup,steady}.cpuprofile of run 1.
    if (opts.profile && opts.out && !profileWritten.has(opts.out)) {
      profileWritten.add(opts.out);
      writeFileSync(`${opts.out}.cold.cpuprofile`, JSON.stringify(coldProfile));
      writeFileSync(`${opts.out}.warmup.cpuprofile`, JSON.stringify(warmupProfile));
      writeFileSync(`${opts.out}.steady.cpuprofile`, JSON.stringify(profile));
    }
    return { cold, warmup, steady, apiRequestsTotal: apiDuringSteady, ...(profile ? { hotspots: topSelfTime(profile), steadyInclusive: topInclusive(profile), warmupInclusive: topInclusive(warmupProfile), warmupByFile: selfTimeByFile(warmupProfile), coldHotspots: topSelfTime(coldProfile), coldByFile: selfTimeByFile(coldProfile), steadyByFile: selfTimeByFile(profile) } : {}) };
  } finally {
    off();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => undefined);
  }
}

const profileWritten = new Set();
let defaultSectionCache = null;
/** The section a fresh profile lands on (verse-ui-store DEFAULTS.section), read from source so it cannot drift. */
async function defaultSection() {
  if (defaultSectionCache) return defaultSectionCache;
  const src = readFileSync(join(repoRoot, 'src/web-ui/routes/verse/verse-ui-store.ts'), 'utf8');
  const m = /const DEFAULTS[^{]*\{[\s\S]*?\bsection:\s*'([a-z]+)'/.exec(src);
  defaultSectionCache = m ? m[1] : 'command';
  return defaultSectionCache;
}

/** Pure: reduce run results to the headline numbers. */
export function summarizeRuns(runs) {
  return {
    coldStartMs: { median: medianOfRuns(runs, (r) => r.cold.fmrMs), p95: round(percentile(runs.map((r) => r.cold.fmrMs), 95)), min: round(Math.min(...runs.map((r) => r.cold.fmrMs))), max: round(Math.max(...runs.map((r) => r.cold.fmrMs))) },
    firstContentfulPaintMs: medianOfRuns(runs, (r) => r.cold.fcpMs),
    warmup: {
      settledAfterMs: medianOfRuns(runs, (r) => r.warmup.settledAfterMs),
      longTasks: medianOfRuns(runs, (r) => r.warmup.longTasks),
      longTaskMs: medianOfRuns(runs, (r) => r.warmup.longTaskMs),
      longTaskMaxMs: medianOfRuns(runs, (r) => r.warmup.longTaskMaxMs),
      resources: medianOfRuns(runs, (r) => r.warmup.resources),
    },
    longTasksBeforeFmr: medianOfRuns(runs, (r) => r.cold.longTasksBeforeFmr),
    longTaskMsBeforeFmr: medianOfRuns(runs, (r) => r.cold.longTaskMsBeforeFmr),
    apiRequestsBeforeFmr: medianOfRuns(runs, (r) => r.cold.apiRequestsBeforeFmr),
    jsRequestsBeforeFmr: medianOfRuns(runs, (r) => r.cold.jsRequestsBeforeFmr),
    jsKbBeforeFmr: medianOfRuns(runs, (r) => r.cold.jsBytesBeforeFmr / 1024),
    steady: {
      frameP50Ms: medianOfRuns(runs, (r) => r.steady.frame.p50),
      frameP95Ms: medianOfRuns(runs, (r) => r.steady.frame.p95),
      frameMaxMs: medianOfRuns(runs, (r) => r.steady.frame.max),
      framesOver50ms: medianOfRuns(runs, (r) => r.steady.frame.over50ms),
      longTasks: medianOfRuns(runs, (r) => r.steady.longTasks.count),
      longTaskTotalMs: medianOfRuns(runs, (r) => r.steady.longTasks.totalMs),
      longTaskMaxMs: medianOfRuns(runs, (r) => r.steady.longTasks.maxMs),
      mainThreadBusyMsPerSec: medianOfRuns(runs, (r) => r.steady.mainThreadBusyMsPerSec),
      scriptMsPerSec: medianOfRuns(runs, (r) => r.steady.scriptMsPerSec),
      layoutMsPerSec: medianOfRuns(runs, (r) => r.steady.layoutMsPerSec),
      styleMsPerSec: medianOfRuns(runs, (r) => r.steady.styleMsPerSec),
      runningAnimations: medianOfRuns(runs, (r) => r.steady.runningAnimations.running),
      domNodes: medianOfRuns(runs, (r) => r.steady.domNodes),
      jsHeapMb: medianOfRuns(runs, (r) => r.steady.jsHeapMb),
    },
  };
}

function printHuman(report) {
  const s = report.summary;
  const lines = [
    `phantom desktop perf  section=${report.section}  runs=${report.runs.length}  steady=${report.steadyMs}ms  ${report.label ? `label=${report.label}  ` : ''}${report.chrome}`,
    `  cold start (first meaningful render)  median ${s.coldStartMs.median} ms   min ${s.coldStartMs.min}  p95 ${s.coldStartMs.p95}  max ${s.coldStartMs.max}`,
    `  first contentful paint                median ${s.firstContentfulPaintMs} ms`,
    `  before first render: ${s.longTasksBeforeFmr} long tasks (${s.longTaskMsBeforeFmr} ms), ${s.apiRequestsBeforeFmr} API requests, ${s.jsRequestsBeforeFmr} JS files (${s.jsKbBeforeFmr} KB)`,
    `  post-render warm-up    quiet after ${s.warmup.settledAfterMs} ms: ${s.warmup.longTasks} long tasks (${s.warmup.longTaskMs} ms, worst ${s.warmup.longTaskMaxMs}), ${s.warmup.resources} more files`,
    `  steady frame interval  p50 ${s.steady.frameP50Ms} ms   p95 ${s.steady.frameP95Ms} ms   max ${s.steady.frameMaxMs} ms   >50ms: ${s.steady.framesOver50ms}`,
    `  steady long tasks      ${s.steady.longTasks} (total ${s.steady.longTaskTotalMs} ms, worst ${s.steady.longTaskMaxMs} ms)`,
    `  steady main thread     ${s.steady.mainThreadBusyMsPerSec} ms/s busy (script ${s.steady.scriptMsPerSec}, layout ${s.steady.layoutMsPerSec}, style ${s.steady.styleMsPerSec})`,
    `  running animations ${s.steady.runningAnimations}   ${(report.runs[0]?.steady.runningAnimations.top ?? []).map(([k, n]) => `${n}× ${k}`).join(', ')}`,
    `  DOM mutations during steady ${report.runs[0]?.steady.domMutations.total}: ${(report.runs[0]?.steady.domMutations.top ?? []).slice(0, 5).map(([k, n]) => `${n}× ${k}`).join(', ')}`,
    `  DOM nodes ${s.steady.domNodes}   JS heap ${s.steady.jsHeapMb} MB`,
  ];
  const hot = report.runs[0]?.hotspots;
  const coldFiles = report.runs[0]?.coldByFile;
  if (coldFiles) lines.push('  cold start, self ms by file (run 1):', ...coldFiles.map((h) => `    ${String(h.ms).padStart(8)}  ${h.url}`));
  const coldHot = report.runs[0]?.coldHotspots;
  if (coldHot) lines.push('  cold start, hottest functions (run 1):', ...coldHot.map((h) => `    ${String(h.ms).padStart(8)}  ${h.fn}  ${h.url}:${h.line}`));
  const incl = report.runs[0]?.steadyInclusive;
  if (incl) lines.push('  steady window, inclusive ms (run 1):', ...incl.slice(0, 12).map((h) => `    ${String(h.ms).padStart(8)}  ${h.fn}  ${h.url}:${h.line}`));
  if (hot) lines.push('  hottest functions in the steady window (run 1, self ms):', ...hot.map((h) => `    ${String(h.ms).padStart(8)}  ${h.fn}  ${h.url}:${h.line}`));
  console.log(lines.join('\n'));
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?|^ \* ?/gm, ''));
    return;
  }
  if (!existsSync(join(repoRoot, 'dist/cli/index.js'))) { console.error('dist/ is missing: run `npm run build` first'); process.exit(2); }
  const chrome = opts.chrome ?? CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) { console.error('no Chrome/Chromium found; pass --chrome <path>'); process.exit(2); }
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'phm-perf-home-'));
  const ownHome = !opts.home;
  let server; let browser;
  try {
    server = await startServer(home);
    browser = await launchChrome(chrome, opts.noSandbox);
    const section = opts.section ?? 'default';
    const resolved = section === 'default' ? await defaultSection() : section;
    const runs = [];
    for (let i = 0; i < opts.runs + 1; i++) {
      const result = await measureRun(browser.cdp, server, opts, section);
      // Run 0 warms the server (module graph, projections) and is discarded.
      if (i === 0) { if (!opts.quiet && !opts.json) console.error('warm-up run discarded'); continue; }
      runs.push(result);
      if (!opts.quiet && !opts.json) console.error(`run ${i}/${opts.runs}: first render ${round(result.cold.fmrMs)} ms, frame p95 ${result.steady.frame.p95} ms`);
    }
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
    const report = { schema: 'ashlr.desktop-perf.v1', version, label: opts.label, section: resolved, steadyMs: opts.steadyMs, chrome: (await browser.cdp.send('Browser.getVersion')).product, platform: process.platform, runs, summary: summarizeRuns(runs) };
    if (opts.out) writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    if (opts.json) console.log(JSON.stringify(report)); else printHuman(report);
  } catch (e) {
    console.error(`measure-desktop-perf: ${e.message}`);
    process.exitCode = 2;
  } finally {
    await browser?.close();
    await server?.stop();
    if (ownHome) rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
