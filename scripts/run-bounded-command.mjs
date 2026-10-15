#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`bounded command: ${message}`);
}

function seconds(value, label) {
  const match = /^(0|[1-9][0-9]*)s$/u.exec(value ?? '');
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 600) {
    fail(`${label} must be 1s-600s`);
  }
  return Number(match[1]) * 1_000;
}

export function parseBoundedCommandArgs(argv) {
  if (argv.length < 5 || argv[0] !== '--signal=TERM' || argv[1] !== '--kill-after=5s') {
    fail('expected --signal=TERM --kill-after=5s <timeout>s <command> [args...]');
  }
  return Object.freeze({
    timeoutMs: seconds(argv[2], 'timeout'),
    killAfterMs: 5_000,
    command: argv[3],
    args: Object.freeze(argv.slice(4)),
  });
}

async function terminate(child, killAfterMs) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, killAfterMs));
  // The leader may exit while descendants remain in its process group. Always
  // address the group after the grace period; ESRCH means it is already gone.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group is already gone */ }
}

// Linux only: true when /proc lists at least one member of the group and every
// member is a zombie (Z) or dead (X). kill(-pgid, 0) still succeeds for such a
// group, because a killed descendant was reparented to init and stays a zombie
// until init reaps it, which a container init may do late or never (`docker
// run` without --init). A zombie runs nothing, so the group has exited. Any
// live member, unreadable entry or non-Linux platform answers false.
function processGroupHasOnlyZombies(pgid) {
  if (process.platform !== 'linux') return false;
  let entries;
  try { entries = readdirSync('/proc'); } catch { return false; }
  let members = 0;
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
      return false;
    }
    // "pid (comm) state ppid pgrp ...": comm may contain ") ", use the last.
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    if (Number(fields[2]) !== pgid) continue;
    if (fields[0] !== 'Z' && fields[0] !== 'X') return false;
    members += 1;
  }
  return members > 0;
}

export function processGroupExists(child) {
  if (!child.pid || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
  } catch {
    return false;
  }
  // Two scans: a member forking between reads cannot slip past both.
  return !(processGroupHasOnlyZombies(child.pid) && processGroupHasOnlyZombies(child.pid));
}

// SIGKILL takes effect asynchronously, when each member is next scheduled.
const GROUP_EXIT_POLL_MS = 25;
const GROUP_EXIT_DEADLINE_MS = 2_000;

async function processGroupExitedWithin(child, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (!processGroupExists(child)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, GROUP_EXIT_POLL_MS));
  }
}

async function ensureProcessTreeGone(child, killAfterMs) {
  if (process.platform === 'win32') return;
  if (processGroupExists(child)) await terminate(child, killAfterMs);
  if (!await processGroupExitedWithin(child, GROUP_EXIT_DEADLINE_MS)) fail('descendant process group survived SIGKILL');
}

export async function runBoundedCommand(options) {
  const child = spawn(options.command, options.args, {
    stdio: 'inherit',
    env: process.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let timedOut = false;
  let termination = null;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    termination ??= terminate(child, options.killAfterMs);
  }, options.timeoutMs);
  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => resolveResult({ code: null, error }));
    child.once('close', (code, signal) => resolveResult({ code, signal }));
  });
  globalThis.clearTimeout(timer);
  if (termination) await termination;
  await ensureProcessTreeGone(child, options.killAfterMs);
  if (result.error) fail(`could not start ${options.command}: ${result.error.message}`);
  if (timedOut) return 124;
  if (typeof result.code === 'number') return result.code;
  return result.signal ? 128 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    process.exitCode = await runBoundedCommand(parseBoundedCommandArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 64;
  }
}
