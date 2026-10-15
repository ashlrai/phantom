#!/usr/bin/env node
/**
 * Cross-tool workflow smoke: drives Phantom with the REAL companion binaries an
 * agent uses (Phantom Secrets, Locus, Lexicon, Ashlr Stack, Ashlr MD) and checks
 * the seams between them: CLI identity, MCP stdio handshakes, Phantom's own
 * readers of companion output, and the Claude Code hook/launcher contracts.
 *
 * Opt-in and local: nothing is installed or downloaded. Every binary is passed
 * explicitly; a check whose binary is absent is reported as `skip`. Each check
 * runs in a disposable HOME with a scrubbed environment, so no user vault,
 * pin, lexicon or stack state is read or written.
 *
 *   node scripts/companion-workflow-smoke.mjs --phm bin/ashlr \
 *     --secrets-bin /path/phantom --secrets-mcp /path/phantom-mcp \
 *     --locus-bin /path/locus --locus-mcp /path/locus-mcp \
 *     --lexicon-bin /path/lexicon --lexicon-mcp /path/mcp-server.mjs --lexicon-hook /path/hook.mjs \
 *     --stack-bin /path/stack --stack-mcp /path/stack-mcp \
 *     --mdopen /path/mdopen --mdopener-mcp /path/mdopener-mcp [--json]
 *
 * Exit 0: no check failed (warn/skip allowed). Exit 1: a seam is broken. Exit 2: bad usage.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SMOKE_SCHEMA = 'phm.companion-workflow-smoke/v1';
/** MCP protocol versions current clients (Claude Code, Cursor, Codex) send. */
export const CLIENT_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26']);
/** Versions a server may answer with that those clients still accept. */
const ACCEPTED_SERVER_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

const FLAGS = Object.freeze({
  '--phm': 'phm', '--secrets-bin': 'secretsBin', '--secrets-mcp': 'secretsMcp',
  '--locus-bin': 'locusBin', '--locus-mcp': 'locusMcp', '--lexicon-bin': 'lexiconBin',
  '--lexicon-mcp': 'lexiconMcp', '--lexicon-hook': 'lexiconHook', '--stack-bin': 'stackBin',
  '--stack-mcp': 'stackMcp', '--mdopen': 'mdopen', '--mdopener-mcp': 'mdopenerMcp',
});

/** Tools each MCP server must list for the workflows Phantom and its docs rely on. */
export const MCP_SERVERS = Object.freeze([
  { id: 'secrets', option: 'secretsMcp', requiredTools: ['phantom_list_secrets', 'phantom_status'] },
  { id: 'locus', option: 'locusMcp', requiredTools: ['locus_whoami', 'locus_status', 'locus_request_pin'] },
  { id: 'lexicon', option: 'lexiconMcp', requiredTools: ['normalize_transcript', 'serve_status'] },
  { id: 'stack', option: 'stackMcp', requiredTools: ['stack_status', 'stack_list'] },
  { id: 'md', option: 'mdopenerMcp', requiredTools: ['open_file'] },
]);

export function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    const key = FLAGS[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value) throw new Error(`${arg} requires a path.`);
    options[key] = resolve(value);
  }
  return options;
}

/** Node entrypoints run under this Node; anything else is executed directly. */
export function commandFor(path, args = []) {
  return /\.(?:c|m)?js$/u.test(path) ? [process.execPath, [path, ...args]] : [path, args];
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'phm-companion-smoke-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

/** Scrubbed environment: disposable HOME, no inherited credentials or config roots. */
export function smokeEnv(home, extraPath = []) {
  const path = [...extraPath, dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]
    .filter(entry => entry && isAbsolute(entry));
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'),
    ASHLR_HOME: join(home, '.ashlr'), LOCUS_HOME: join(home, '.locus'),
    LEXICON_PATH: join(home, '.config', 'lexicon', 'lexicon.yaml'),
    TMPDIR: join(home, '..'), NO_COLOR: '1', CI: '1', PATH: [...new Set(path)].join(delimiter),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

/** Run to completion with a hard bound; a hang is reported, never waited on. */
export function run(path, args, { env, cwd, input, timeoutMs = 20_000 } = {}) {
  const [cmd, argv] = commandFor(path, args);
  return new Promise(resolvePromise => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false;
    let child;
    try {
      child = spawn(cmd, argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolvePromise({ code: null, stdout, stderr: String(error), timedOut, ms: 0 });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += String(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    });
    child.stdin.end(input ?? '');
  });
}

/**
 * Minimal newline-delimited JSON-RPC client for a stdio MCP server: initialize,
 * notifications/initialized, tools/list. Non-JSON on stdout is a protocol break.
 */
export async function mcpHandshake(path, { env, cwd, protocolVersion, timeoutMs = 20_000 }) {
  const [cmd, argv] = commandFor(path);
  const child = spawn(cmd, argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const noise = [];
  let buffer = '', stderr = '', nextId = 0, exited = null;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { exited = String(error); for (const fail of pending.values()) fail.reject(new Error(exited)); });
  child.on('exit', code => { exited = `exited ${code}`; for (const fail of pending.values()) fail.reject(new Error(`server ${exited}: ${stderr.trim().slice(-300)}`)); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { noise.push(line.slice(0, 120)); continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    if (exited) { reject(new Error(`server ${exited}: ${stderr.trim().slice(-300)}`)); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, {
      resolve: message => { clearTimeout(timer); resolveRequest(message); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await request('initialize', {
      protocolVersion, capabilities: {}, clientInfo: { name: 'phm-companion-smoke', version: '1' },
    });
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error).slice(0, 200)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await request('tools/list', {});
    if (list.error) throw new Error(`tools/list error: ${JSON.stringify(list.error).slice(0, 200)}`);
    return {
      serverInfo: init.result?.serverInfo ?? null,
      protocolVersion: init.result?.protocolVersion ?? null,
      tools: (list.result?.tools ?? []).map(tool => tool.name),
      noise,
    };
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
  }
}

export function evaluateHandshake(server, protocolVersion, result) {
  const problems = [];
  if (!ACCEPTED_SERVER_VERSIONS.has(result.protocolVersion)) problems.push(`answered unsupported protocol ${result.protocolVersion}`);
  if (result.noise.length) problems.push(`wrote non-JSON to stdout: ${result.noise[0]}`);
  const missing = server.requiredTools.filter(name => !result.tools.includes(name));
  if (missing.length) problems.push(`missing tools: ${missing.join(', ')}`);
  const name = result.serverInfo ? `${result.serverInfo.name}@${result.serverInfo.version}` : 'unnamed server';
  const detail = `${name}, ${result.tools.length} tools, client ${protocolVersion} -> server ${result.protocolVersion}`;
  if (problems.length) return { status: 'fail', detail: `${detail}; ${problems.join('; ')}` };
  return {
    status: result.protocolVersion === protocolVersion ? 'pass' : 'warn',
    detail: result.protocolVersion === protocolVersion ? detail : `${detail} (older version, still accepted)`,
  };
}

/** Phantom's companion inventory: reviewed version match is pass, newer release is drift. */
export function evaluateCompanion(entry) {
  const detail = `${entry.status}${entry.version ? ` ${entry.version}` : ''} (reviewed ${entry.reviewedRelease.version})`;
  if (entry.status === 'known-interface') return { status: 'pass', detail };
  if (entry.status === 'unsupported-version') return { status: 'warn', detail: `${detail}: Phantom's reviewed pin needs a contract review` };
  return { status: 'fail', detail: `${detail}: ${entry.guidance}` };
}

const STACK_TOML = `[stack]\nversion = "1"\n\n[[environments]]\nname = "dev"\ndefault = true\n\n` +
  `[services.supabase]\nprovider = "supabase"\nsecrets = ["SUPABASE_URL", "SUPABASE_ANON_KEY"]\nmcp = "supabase"\n\n` +
  `[services.openai]\nprovider = "openai"\nsecrets = ["OPENAI_API_KEY"]\n`;

export async function runSmoke(options) {
  const checks = [];
  const add = (id, result) => checks.push({ id, ...result });
  const skip = (id, why) => add(id, { status: 'skip', detail: why });
  const present = key => Boolean(options[key] && existsSync(options[key]));
  const box = sandbox();
  try {
    const env = smokeEnv(box.home, [options.stackBin, options.secretsBin].filter(Boolean).map(dirname));

    // 1. Phantom identifies each installed companion it has a reviewed contract for.
    const companionFlags = [['secrets', 'secretsBin'], ['locus', 'locusBin'], ['lexicon', 'lexiconBin']]
      .filter(([, key]) => present(key));
    if (!present('phm')) skip('phm:companions', 'no --phm');
    else if (!companionFlags.length) skip('phm:companions', 'no companion CLI given');
    else {
      const args = ['companions', '--json', '--bin-dir', box.root];
      for (const [id, key] of companionFlags) args.push(`--${id}-bin`, options[key]);
      const result = await run(options.phm, args, { env, cwd: box.home });
      if (result.code !== 0) add('phm:companions', { status: 'fail', detail: `exit ${result.code}: ${result.stderr.trim().slice(0, 200)}` });
      else {
        const report = JSON.parse(result.stdout);
        for (const [id] of companionFlags) {
          const entry = report.companions.find(item => item.id === id);
          add(`phm:companions:${id}`, entry ? evaluateCompanion(entry) : { status: 'fail', detail: 'not in report' });
        }
      }
    }

    // 2. Every MCP server completes the handshake current clients send.
    for (const server of MCP_SERVERS) {
      if (!present(server.option)) { skip(`${server.id}:mcp`, `no --${server.option.replace(/[A-Z]/gu, c => `-${c.toLowerCase()}`)}`); continue; }
      for (const protocolVersion of CLIENT_PROTOCOL_VERSIONS) {
        const id = `${server.id}:mcp:${protocolVersion}`;
        try {
          const result = await mcpHandshake(options[server.option], { env, cwd: box.home, protocolVersion });
          add(id, evaluateHandshake(server, protocolVersion, result));
        } catch (error) {
          add(id, { status: 'fail', detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    // 3. Phantom reads the services a Stack project wires (`phm stack status --json`).
    if (!present('phm') || !present('stackBin')) skip('phm:stack-status', 'needs --phm and --stack-bin');
    else {
      const project = join(box.home, 'stack-project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, '.stack.toml'), STACK_TOML);
      const shim = join(box.root, 'stack-shim');
      mkdirSync(shim, { recursive: true });
      // Phantom resolves `stack` from PATH; point that name at the binary under test.
      const [cmd, argv] = commandFor(options.stackBin);
      if (process.platform !== 'win32') {
        writeFileSync(join(shim, 'stack'), `#!/bin/sh\nexec ${[cmd, ...argv].map(part => `'${part.replace(/'/gu, `'\\''`)}'`).join(' ')} "$@"\n`);
        chmodSync(join(shim, 'stack'), 0o755);
      }
      const stackEnv = { ...env, PATH: [shim, env.PATH].join(delimiter) };
      // Stack's own machine report (`ashlr.stack.status/v1`), which Phantom prefers.
      const direct = await run(options.stackBin, ['status', '--json'], { env: stackEnv, cwd: project });
      let report = null;
      try { report = JSON.parse(direct.stdout); } catch { /* reported below */ }
      const names = Array.isArray(report?.services) ? report.services.map(item => item?.name).sort() : [];
      add('stack:status-json', direct.code === 0 && names.join(',') === 'openai,supabase'
        ? { status: 'pass', detail: `${report.schema ?? 'unversioned'} lists ${names.join(', ')}` }
        : { status: 'fail', detail: `stack status --json exit ${direct.code}: ${report ? 'services missing' : 'not JSON'}` });
      const result = await run(options.phm, ['stack', 'status', '--json'], { env: stackEnv, cwd: project });
      let parsed = null;
      try { parsed = JSON.parse(result.stdout); } catch { /* reported below */ }
      const services = Array.isArray(parsed?.services) ? [...parsed.services].sort() : [];
      add('phm:stack-status', services.join(',') === 'openai,supabase'
        ? { status: 'pass', detail: `Phantom saw ${services.join(', ')}` }
        : { status: 'fail', detail: `expected openai, supabase; got ${result.stdout.trim().slice(0, 200) || `exit ${result.code} ${result.stderr.trim().slice(0, 200)}`}` });
    }

    // 4. Lexicon's Claude Code hook: always exit 0, fast, and stdout is JSON or empty.
    if (!present('lexiconHook')) skip('lexicon:hook', 'no --lexicon-hook');
    else {
      const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'open the ashler stack readme', cwd: box.home, session_id: 'smoke' });
      const result = await run(options.lexiconHook, [], { env, cwd: box.home, input: payload, timeoutMs: 10_000 });
      let stdoutOk = result.stdout.trim() === '';
      if (!stdoutOk) { try { JSON.parse(result.stdout); stdoutOk = true; } catch { /* not JSON */ } }
      add('lexicon:hook', result.code === 0 && stdoutOk && !result.timedOut
        ? { status: result.ms < 2_000 ? 'pass' : 'warn', detail: `exit 0 in ${result.ms} ms` }
        : { status: 'fail', detail: `exit ${result.code}${result.timedOut ? ' (timed out)' : ''}, stdout ${stdoutOk ? 'ok' : 'not JSON'}` });
    }

    // 5. `mdopen` (what Phantom's Markdown presenter launches) returns promptly and honestly.
    if (!present('mdopen')) skip('md:mdopen', 'no --mdopen');
    else {
      const file = join(box.home, 'smoke.md');
      writeFileSync(file, '# Smoke\n');
      const result = await run(options.mdopen, [file], { env, cwd: box.home, timeoutMs: 20_000 });
      if (result.timedOut) add('md:mdopen', { status: 'fail', detail: 'did not return within 20 s' });
      else if (result.code === 0) add('md:mdopen', { status: 'pass', detail: `launched in ${result.ms} ms` });
      else add('md:mdopen', result.stderr.trim()
        ? { status: 'pass', detail: `no viewer here; exit ${result.code} with reason in ${result.ms} ms` }
        : { status: 'fail', detail: `exit ${result.code} without a reason` });
    }

    // 6. Locus: a human pin read through Phantom's own Locus parsers, with and without
    // the exported control capability. `ready` must never outrun a verified anchor.
    const locusDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'core', 'integrations', 'locus.js');
    if (!present('locusBin')) skip('locus:pin-report', 'no --locus-bin');
    else if (process.platform === 'win32') skip('locus:pin-report', 'needs a POSIX shell for the pin hook');
    else if (!existsSync(locusDist)) skip('locus:pin-report', 'Phantom dist not built (npm run build)');
    else {
      for (const [id, check] of await locusPinReport(options.locusBin, locusDist, env, box.home)) add(id, check);
    }

    // 7. Secrets: a project secret reaches an upstream only through `phantom exec`'s proxy.
    if (!present('secretsBin')) skip('secrets:exec-proxy', 'no --secrets-bin');
    else add('secrets:exec-proxy', await secretsExecProxy(options.secretsBin, env, box.home));
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
  return { schema: SMOKE_SCHEMA, ok: checks.every(check => check.status !== 'fail'), checks };
}

const LOCUS_READER = `
const m = await import(process.env.PHM_SMOKE_LOCUS_DIST);
const read = () => {
  const probe = m.locusAgentReport();
  const report = probe.report ?? null;
  const oneline = m.locusStatusOneline();
  return { exit: probe.exitCode, gateOk: probe.gateOk ?? null, error: probe.error ?? null,
    missing: report ? m.missingAgentReportKeys(report) : null, ready: report?.ready ?? null,
    status: report?.status ?? null, anchor: report?.pin?.authority_anchor_verified ?? null,
    reportOneline: report?.status_oneline ?? null, oneline, healthy: m.isStatusOnelineHealthy(oneline) };
};
const withCap = read();
delete process.env.LOCUS_CONTROL_CAPABILITY;
process.stdout.write(JSON.stringify({ withCap, withoutCap: read() }));
`;

/** One shell, because a Locus pin's broker lives only as long as the shell that pinned. */
export async function locusPinReport(locusBin, locusDist, env, home) {
  const script = [
    'set -e',
    'locus quickstart >/dev/null 2>&1',
    'eval "$(locus hook bash)"',
    'test -n "$LOCUS_CONTROL_CAPABILITY" || { echo "hook exported no capability" >&2; exit 3; }',
    // Registers locus-mcp in the sandbox project's .mcp.json, as `locus setup` does for a user.
    'locus setup --client claude >/dev/null',
    `"${process.execPath}" --input-type=module -e "$PHM_SMOKE_LOCUS_READER"`,
    // Without a trailing command bash execs into node, which replaces the
    // pinning (supervising) process and makes Locus end the pin on purpose.
    'exit $?',
  ].join('\n');
  const result = await run('bash', ['-c', script], {
    cwd: home, timeoutMs: 30_000,
    env: { ...env, PATH: [dirname(locusBin), env.PATH].join(delimiter), LOCUS_BIN: locusBin,
      PHM_SMOKE_LOCUS_DIST: locusDist, PHM_SMOKE_LOCUS_READER: LOCUS_READER },
  });
  let data;
  try { data = JSON.parse(result.stdout); } catch {
    return [['locus:pin-report', { status: 'fail', detail: `pin flow exit ${result.code}: ${result.stderr.trim().slice(-200)}` }]];
  }
  const describe = view => `status=${view.status} ready=${view.ready} anchor=${view.anchor} oneline=${view.oneline}`;
  const consistent = view => view.ready !== true || (view.anchor !== false && view.healthy);
  const checks = [];
  const withCap = data.withCap;
  checks.push(['locus:pin-report', withCap.missing?.length === 0 && withCap.healthy && withCap.anchor === true
    ? { status: 'pass', detail: `Phantom parsed the pinned report: ${describe(withCap)}` }
    : { status: 'fail', detail: `with capability: ${describe(withCap)}, missing keys ${JSON.stringify(withCap.missing)}${withCap.error ? `, ${withCap.error}` : ''}` }]);
  for (const [label, view] of [['with', withCap], ['without', data.withoutCap]]) {
    checks.push([`locus:ready-consistency:${label}-capability`, consistent(view)
      ? { status: 'pass', detail: describe(view) }
      : { status: 'fail', detail: `ready=true while the anchor or oneline is not healthy: ${describe(view)}` }]);
  }
  return checks;
}

const SECRET_SENTINEL = 'sk-smoke-NEVER-IN-AGENT-ENV-0123456789abcdef';
const ENV_PROBE = `const e = process.env; process.stdout.write('PHM_SMOKE ' + JSON.stringify({
  key: e.OPENAI_API_KEY ?? null, base: e.OPENAI_BASE_URL ?? null,
  leak: Object.values(e).some(v => typeof v === 'string' && v.includes(${JSON.stringify(SECRET_SENTINEL.slice(0, 24))})) }))`;

/**
 * Store a sentinel secret (stdin only, as agents must), then run a child under
 * `phantom exec`: the child sees a phm_ placeholder and a loopback base URL, never the value.
 */
export async function secretsExecProxy(secretsBin, env, home) {
  const project = join(home, 'secrets-project');
  mkdirSync(project, { recursive: true });
  // Headless hosts have no keychain; the encrypted-file vault needs a passphrase.
  const secretsEnv = { ...env, PHANTOM_VAULT_PASSPHRASE: 'phm-companion-smoke-passphrase' };
  const init = await run(secretsBin, ['init', '--empty'], { env: secretsEnv, cwd: project });
  if (init.code !== 0) return { status: 'fail', detail: `phantom init --empty exit ${init.code}: ${init.stderr.trim().slice(0, 200)}` };
  const add = await run(secretsBin, ['add', 'OPENAI_API_KEY', '--stdin'], { env: secretsEnv, cwd: project, input: SECRET_SENTINEL });
  if (add.code !== 0) return { status: 'fail', detail: `phantom add --stdin exit ${add.code}: ${add.stderr.trim().slice(0, 200)}` };
  const dotenv = readFileSync(join(project, '.env'), 'utf8');
  if (dotenv.includes(SECRET_SENTINEL)) return { status: 'fail', detail: '.env holds the real value' };
  const exec = await run(secretsBin, ['exec', '--', process.execPath, '-e', ENV_PROBE], { env: secretsEnv, cwd: project, timeoutMs: 30_000 });
  const line = (exec.stdout.split('\n').find(entry => entry.startsWith('PHM_SMOKE ')) ?? '').slice('PHM_SMOKE '.length);
  let seen;
  try { seen = JSON.parse(line); } catch {
    return { status: 'fail', detail: `phantom exec exit ${exec.code}${exec.timedOut ? ' (timed out)' : ''}: no child output` };
  }
  const problems = [];
  if (seen.leak || [exec.stdout, exec.stderr].some(text => text.includes(SECRET_SENTINEL))) problems.push('real value reached the child or the output');
  if (!/^phm_[A-Za-z0-9]+$/u.test(seen.key ?? '')) problems.push('OPENAI_API_KEY is not a phm_ placeholder');
  if (!/^http:\/\/127\.0\.0\.1:\d+\//u.test(seen.base ?? '')) problems.push('OPENAI_BASE_URL is not the loopback proxy');
  return problems.length
    ? { status: 'fail', detail: problems.join('; ') }
    : { status: 'pass', detail: 'child saw a phm_ placeholder and a loopback proxy URL; value stayed in the vault' };
}

function printHuman(report) {
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
  for (const check of report.checks) process.stdout.write(`${mark[check.status]} ${check.id}: ${check.detail}\n`);
  const count = status => report.checks.filter(check => check.status === status).length;
  process.stdout.write(`\n${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail, ${count('skip')} skip\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/u, '').replace(/^ \* ?/gmu, ''));
    process.exit(0);
  }
  const report = await runSmoke(options);
  if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);
  process.exit(report.ok ? 0 : 1);
}

