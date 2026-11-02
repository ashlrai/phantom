#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const usage = `Usage: node scripts/agent-wait-capacity.mjs [--lane <name>]... [--phm-bin <executable>] [--deadline-ms <1..3600000>] [--interval-ms <1..60000>]
Polls phm fleet runs --json immediately and until capacity or the deadline.
Example: node scripts/agent-wait-capacity.mjs --lane codex-personal --lane claude --phm-bin phm --deadline-ms 60000 --interval-ms 5000
Defaults: phm, 60000ms deadline, 5000ms interval. Emits one JSON object:
{ outcome: "capacity"|"deadline", selected: [...], evidence: {...} }.
Only healthy status, paused=false, held=false and known nonnegative integer running < positive target qualify. Other source health is retained. Child errors are sanitized; SIGINT/SIGTERM cancel the wait.`;
const id = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const healthKeys = ['status', 'claimed', 'events', 'metrics', 'claudeLane', 'switches', 'drop'];
const healthValues = new Set(['healthy', 'missing', 'degraded']);

function parseArgs(args) {
  const options = { lanes: [], bin: 'phm', deadline: 60000, interval: 5000, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      if (seen.has('help')) throw new Error();
      seen.add('help'); options.help = true; continue;
    }
    if (!['--lane', '--phm-bin', '--deadline-ms', '--interval-ms'].includes(flag) || (flag !== '--lane' && seen.has(flag))) throw new Error();
    seen.add(flag);
    const value = args[++i];
    if (value === undefined || value.length === 0 || value.startsWith('--')) throw new Error();
    if (flag === '--lane') {
      if (!id.test(value)) throw new Error();
      options.lanes.push(value);
    } else if (flag === '--phm-bin') {
      if (value.includes('\0')) throw new Error();
      options.bin = value;
    } else {
      const max = flag === '--deadline-ms' ? 3600000 : 60000;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw new Error();
      if (flag === '--deadline-ms') options.deadline = Number(value);
      else options.interval = Number(value);
    }
  }
  return options;
}

const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
function project(value, filters) {
  const state = obj(value);
  if (state.v !== 1 || !Array.isArray(state.lanes)) return { error: 'INVALID_RESPONSE' };
  const source = obj(state.sources);
  const sources = Object.fromEntries(healthKeys.map(key => [key, healthValues.has(source[key]) ? source[key] : null]));
  const lanes = state.lanes.flatMap(value => {
    const lane = obj(value);
    if (typeof lane.lane !== 'string' || !id.test(lane.lane) || (filters.length && !filters.includes(lane.lane))) return [];
    return [{ lane: lane.lane, running: count(lane.running), target: count(lane.target), held: bool(lane.held) }];
  });
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
  return { v: 1, generatedAt: timestamp(state.generatedAt), lastTick: timestamp(state.lastTick),
    sourceState: healthValues.has(state.sourceState) ? state.sourceState : null, sources, paused: bool(state.paused), lanes };
}

// Output is capped; stderr is discarded and no error text or exit status is echoed.
function readSnapshot(bin, timeout, signal) {
  return new Promise(resolve => {
    let child, error, bytes = 0, output = [];
    let timer, killTimer;
    const finish = result => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = code => {
      if (error) return;
      error = code;
      child.stdout.destroy();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 200);
    };
    const abort = () => stop('CANCELLED');
    try { child = spawn(bin, ['fleet', 'runs', '--json'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { finish({ error: 'SPAWN_FAILED' }); return; }
    child.on('error', () => { error ||= 'SPAWN_FAILED'; });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { output = []; stop('OUTPUT_LIMIT'); }
      else if (!error) output.push(chunk);
    });
    child.on('close', code => {
      if (error) finish({ error });
      else if (code !== 0) finish({ error: 'CHILD_FAILED' });
      else {
        try { finish({ value: JSON.parse(Buffer.concat(output).toString('utf8')) }); }
        catch { finish({ error: 'INVALID_JSON' }); }
      }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => stop('CHILD_TIMEOUT'), timeout);
  });
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch { process.stderr.write(`error: invalid arguments\n${usage}\n`); return 2; }
  if (options.help) { console.log(usage); return 0; }
  const controller = new AbortController();
  let cancelled = 0;
  const interrupt = () => { cancelled = 130; controller.abort(); };
  const terminate = () => { cancelled = 143; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const end = performance.now() + options.deadline;
  let evidence = { error: 'NO_SNAPSHOT' };
  try {
    while (!controller.signal.aborted) {
      const remaining = end - performance.now();
      if (remaining <= 0) break;
      const result = await readSnapshot(options.bin, Math.max(1, Math.min(10000, remaining)), controller.signal);
      if (controller.signal.aborted) break;
      evidence = result.error ? result : project(result.value, options.lanes);
      const selected = evidence.sources?.status === 'healthy' && evidence.paused === false
        ? evidence.lanes.filter(lane => lane.held === false && lane.running !== null && lane.target !== null && lane.target > 0 && lane.running < lane.target) : [];
      if (selected.length && performance.now() < end) {
        console.log(JSON.stringify({ outcome: 'capacity', selected, evidence })); return 0;
      }
      const wait = Math.min(options.interval, end - performance.now());
      if (wait > 0) await delay(wait, undefined, { signal: controller.signal }).catch(() => {});
    }
    if (cancelled) return cancelled;
    console.log(JSON.stringify({ outcome: 'deadline', selected: [], evidence }));
    return 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
process.exitCode = await main();
