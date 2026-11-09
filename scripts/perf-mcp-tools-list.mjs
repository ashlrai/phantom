#!/usr/bin/env node
/**
 * scripts/perf-mcp-tools-list.mjs — MCP tools/list latency harness.
 *
 * Spawns the Phantom MCP gateway (`node bin/ashlr mcp`), speaks the
 * initialize → notifications/initialized → tools/list handshake over stdio,
 * and exits 0 when the tools/list response arrives. perf-budget.mjs times
 * this as an ordinary target, so the measured wall time covers gateway
 * startup plus the tools/list answer — the latency an MCP client feels.
 *
 * Hermetic: the caller controls HOME/ASHLR_HOME (perf-budget --home) and no
 * credentials are requested or printed; only JSON-RPC envelopes are
 * exchanged. A missing build or a gateway that exits early is an error, not
 * a fast pass.
 *
 * Diagnostic detail goes to stderr (timers only read exit status).
 *
 * Usage: node scripts/perf-mcp-tools-list.mjs
 * Env:   ASHLR_PERF_MCP_TIMEOUT_MS — overall deadline (default 30000)
 */
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = Number(process.env.ASHLR_PERF_MCP_TIMEOUT_MS ?? 30_000);

function fail(msg) {
  console.error(`perf-mcp-tools-list: ${msg}`);
  process.exit(1);
}

const started = performance.now();
const child = spawn(process.execPath, [resolve(repoRoot, 'bin/ashlr'), 'mcp'], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: process.env,
});

let buffer = '';
let initializedAt = 0;
let done = false;

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  fail(`timed out after ${TIMEOUT_MS} ms waiting for tools/list`);
}, TIMEOUT_MS);

function send(msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function finish(msg) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  const total = performance.now() - started;
  const toolCount = Array.isArray(msg.result?.tools) ? msg.result.tools.length : -1;
  console.error(
    `perf-mcp-tools-list: ${total.toFixed(1)}ms total ` +
    `(initialize ${(initializedAt - started).toFixed(1)}ms, ` +
    `tools/list ${(performance.now() - initializedAt).toFixed(1)}ms, ${toolCount} tools)`,
  );
  child.kill('SIGKILL');
  // Let the SIGKILL land before exiting; the timer reads our exit code.
  setTimeout(() => process.exit(0), 25).unref();
}

child.on('error', (err) => {
  clearTimeout(timer);
  fail(`spawn failed: ${err.message}`);
});
child.on('exit', (code) => {
  if (!done) {
    clearTimeout(timer);
    fail(`gateway exited ${code} before answering tools/list`);
  }
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // non-protocol chatter is not an error for timing
    }
    if (msg.id === 1 && initializedAt === 0) {
      initializedAt = performance.now();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      finish(msg);
      return;
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ashlr-perf-budget', version: '0.0.0' },
  },
});
