#!/usr/bin/env node
import { spawn } from 'node:child_process';

const HELP = `Usage: node scripts/agent-boot-report.mjs [--phm-bin <executable>] [--timeout-ms <100..60000>]
       node scripts/agent-boot-report.mjs --help

Read fleet runs, canonical workers, the resource ledger and durable bus status
concurrently. Default executable: phm; overall deadline: 10000 ms. No shell is
used. Each stdout is limited to 2 MiB; stderr is discarded. JSON data, including
unknown fields and nonzero-exit evidence, is preserved. The report's v is 1;
results have status ok/error, a stable error code (or null), and data (or null).
Exit 0 when all commands succeed, 1 on partial failure, 2 on invalid arguments,
130 on SIGINT and 143 on SIGTERM. Cancellation emits the completed evidence.`;
const COMMANDS = {
  fleetRuns: ['fleet', 'runs', '--json'],
  fleetWorkers: ['fleet', 'workers', '--json'],
  resourceLedger: ['resources', 'ledger', '--json'],
  busStatus: ['comms', 'bus', 'status'],
};
const MAX_BYTES = 2 * 1024 * 1024;

function options(args) {
  const seen = new Set();
  let bin = 'phm', timeout = 10000, help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] === '-h' ? '--help' : args[i];
    if (seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--help') help = true;
    else if (arg === '--phm-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-') || value.includes('\0')) return null;
      bin = value;
    } else if (arg === '--timeout-ms') {
      const value = args[++i];
      if (!value || !/^[0-9]+$/.test(value) || Number(value) < 100 || Number(value) > 60000) return null;
      timeout = Number(value);
    } else return null;
  }
  return { bin, timeout, help };
}

function read(bin, args, signal) {
  return new Promise(resolve => {
    let child, finished = false, bytes = 0;
    const chunks = [];
    const finish = (code, data = null) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      resolve({ status: code === null ? 'ok' : 'error', code, data });
    };
    const stop = code => {
      if (finished) return;
      child?.kill('SIGKILL');
      child?.stdout?.destroy();
      finish(code);
    };
    const abort = () => stop(signal.reason);
    if (signal.aborted) return abort();
    try {
      child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish('spawn_failed');
    }
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish('spawn_failed'));
    child.stdout.on('error', () => stop('read_failed'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop('output_limit');
      else chunks.push(chunk);
    });
    child.on('close', (exitCode, exitSignal) => {
      if (finished) return;
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(exitCode === 0 ? 'invalid_json' : 'exit_nonzero'); }
      finish(exitSignal || exitCode !== 0 ? 'exit_nonzero' : null, data);
    });
  });
}

const config = options(process.argv.slice(2));
if (!config) {
  process.stderr.write('Invalid arguments. Use --help for usage.\n');
  process.exitCode = 2;
} else if (config.help) {
  console.log(HELP);
} else {
  const controller = new AbortController();
  let interrupted = 0;
  const onInt = () => { interrupted = 130; controller.abort('cancelled'); };
  const onTerm = () => { interrupted = 143; controller.abort('cancelled'); };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  const timer = setTimeout(() => controller.abort('timeout'), config.timeout);
  const entries = await Promise.all(Object.entries(COMMANDS).map(async ([name, args]) =>
    [name, await read(config.bin, args, controller.signal)]));
  clearTimeout(timer);
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  const results = Object.fromEntries(entries);
  console.log(JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), results }));
  process.exitCode = interrupted || (entries.some(([, result]) => result.status !== 'ok') ? 1 : 0);
}
