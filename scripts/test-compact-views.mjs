// Headless Chromium renders the real components, CSS and fonts in 390px frames.
// No live backend, credentials, added dependencies or browser downloads.
import { build } from 'esbuild';
/* global setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const scratch = await mkdtemp(join(tmpdir(), 'compact-views-'));
const chrome = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let browser;
try {
  // Match Vite's browser boundary: these transitive server helpers must never run.
  const builtins = { name: 'browser-builtins', setup(builder) {
    builder.onResolve({ filter: /^node:/ }, args => ({ path: args.path, namespace: 'browser' }));
    builder.onLoad({ filter: /.*/, namespace: 'browser' }, () => ({ contents: 'export const readFileSync = () => { throw Error("Server API in browser"); }; export const homedir = readFileSync;' }));
  } };
  await build({ entryPoints: ['src/web-ui/test/compact-views.browser.tsx'], outfile: join(scratch, 'app.js'), bundle: true, format: 'esm', jsx: 'automatic', plugins: [builtins], loader: { '.woff2': 'file' }, define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(scratch, 'index.html'), '<!doctype html><link rel="stylesheet" href="app.css"><body><script>addEventListener("error", e => { const p = document.createElement("pre"); p.textContent = "FAIL " + e.message; document.body.append(p); parent.postMessage(p.textContent, "*"); });</script><script type="module" src="app.js"></script>');
  browser = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', '--allow-file-access-from-files', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-gpu', '--disable-crash-reporter', '--disable-extensions', '--disable-sync', `--user-data-dir=${join(scratch, 'profile')}`, ...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [])], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0, buffer = '';
  browser.stdio[4].on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\0')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const call = pending.get(message.id); if (call) { pending.delete(message.id); if (message.error) call.reject(message.error); else call.resolve(message.result); } }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
    pending.set(++id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.navigate', { url: pathToFileURL(join(scratch, 'index.html')).href }, sessionId);
  let results = [];
  for (let i = 0; i < 200 && results.length < 6; i++) {
    const { result } = await send('Runtime.evaluate', { expression: '[...document.querySelectorAll("pre")].map(el => el.textContent)', returnByValue: true }, sessionId);
    results = result.value ?? []; await pause();
  }
  for (const name of ['Goals', 'Goals page', 'Feed', 'Usage', 'Work log', 'Feed actions']) assert(results.includes(`PASS ${name} at 390px`), results.join('\n') || 'Browser produced no results');
  assert(!results.some(result => result.startsWith('FAIL')), results.join('\n'));
  console.log(results.join('\n'));
} finally {
  browser?.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
