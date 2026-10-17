#!/usr/bin/env node
/**
 * Cross-tool workflow smoke: drives Phantom with the REAL companion binaries an
 * agent uses (Phantom Secrets, Locus, Lexicon, Ashlr Stack, Ashlr MD, the
 * Ashlr.AI Plugin) and checks
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
 *     --mdopen /path/mdopen --mdopener-mcp /path/mdopener-mcp \
 *     --plugin-dir /path/ashlr-plugin --cortex-url https://cortex.ashlr.ai/api/mcp [--json]
 *
 * Workflow checks also drive tools together: Locus resolving a `phm:` credential
 * through Phantom Secrets, and Stack reading a project's Phantom Secrets vault.
 * --cortex-url sends two unauthenticated requests to a Cortex MCP endpoint and
 * expects its 401 Bearer challenge; it never sends a real token.
 *
 * --plugin-dir is an ashlr-plugin checkout (after `bun install`) or installed
 * package; its MCP router needs Bun and ripgrep on PATH.
 *
 * --published [--prefix <dir>] checks what users install instead: the published
 * npm packages go into a temp npm prefix (or <dir>, kept for reuse) with
 * `npm install --ignore-scripts` (no package needs its postinstall; native
 * binaries download lazily on first run, into the disposable HOME), and each
 * binary resolves from <prefix>/node_modules/.bin. Explicit flags still win.
 * Ashlr MD has no npm package: on x64 Linux its latest GitHub release .deb is
 * unpacked into the prefix instead (curl + dpkg-deb). The report lists each
 * installed version. Needs network to npm and GitHub.
 *
 * Exit 0: no check failed (warn/skip allowed). Exit 1: a seam is broken. Exit 2: bad usage.
 */
/* global fetch, AbortSignal */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  '--plugin-dir': 'pluginDir',
});
/** Flags whose value is a URL, not a path. */
const URL_FLAGS = Object.freeze({ '--cortex-url': 'cortexUrl' });

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
    if (arg === '--published') { options.published = true; continue; }
    if (arg === '--prefix') {
      const value = argv[++i];
      if (!value) throw new Error('--prefix requires a path.');
      options.prefix = resolve(value);
      options.published = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (URL_FLAGS[arg]) {
      const value = argv[++i];
      if (!value || !/^https?:\/\//u.test(value)) throw new Error(`${arg} requires an http(s) URL.`);
      options[URL_FLAGS[arg]] = value;
      continue;
    }
    const key = FLAGS[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value) throw new Error(`${arg} requires a path.`);
    options[key] = resolve(value);
  }
  return options;
}

/**
 * What users install from npm. `bins` maps a smoke option to the package's
 * `node_modules/.bin` name; `files` to a shipped file that is not a bin.
 * `native` names what the npm wrapper downloads on first run (under the
 * disposable HOME): the native CLI, which `phm companions` requires because it
 * deliberately refuses bootstrap launchers, and the MCP server shipped with it.
 */
export const PUBLISHED_PACKAGES = Object.freeze([
  { name: '@ashlr/phantom', bins: { phm: 'phm' } },
  { name: 'phantom-secrets', bins: { secretsBin: 'phantom' }, native: { secretsBinNative: ['.phantom-secrets', 'bin', 'phantom'], secretsMcp: ['.phantom-secrets', 'bin', 'phantom-mcp'] } },
  { name: 'locus-cli', bins: { locusBin: 'locus' }, native: { locusBinNative: ['.locus', 'bin', 'locus'], locusMcp: ['.locus', 'bin', 'locus-mcp'] } },
  { name: '@ashlr/lexicon', bins: { lexiconBin: 'lexicon', lexiconMcp: 'lexicon-mcp' }, files: { lexiconHook: 'plugin/hook.mjs' } },
  { name: '@ashlr/stack', bins: { stackBin: 'stack' } },
  { name: 'ashlr-stack-mcp', bins: { stackMcp: 'ashlr-stack-mcp' } },
  { name: 'ashlr-plugin', files: { pluginDir: '.' } },
]);

/**
 * The Ashlr.AI Plugin's MCP router, launched the way its Claude Code manifest does
 * (`node scripts/bootstrap.mjs servers/_router.ts`, which hands off to Bun).
 */
export const PLUGIN_SERVER = Object.freeze({
  id: 'plugin', entry: ['scripts', 'bootstrap.mjs'], args: ['servers/_router.ts'],
  requiredTools: ['ashlr__grep', 'ashlr__read', 'ashlr__tree'],
});
/** Ashlr MD ships no npm package; on x64 Linux its GitHub release .deb carries both binaries. */
export const MD_RELEASE = Object.freeze({
  repo: 'ashlrai/ashlr-md', dir: 'ashlr-md', libDir: ['usr', 'lib', 'Ashlr MD'],
  bins: { mdopen: 'mdopen', mdopenerMcp: 'mdopener-mcp' },
});

/**
 * Download the latest Ashlr MD release .deb into `<prefix>/ashlr-md` and unpack it
 * (curl + dpkg-deb, so the environment's proxy settings apply). Returns the release
 * tag, or a reason it could not (other platforms, missing tools, network).
 */
export async function installMdRelease(prefix, { timeoutMs = 180_000 } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') return { reason: 'Ashlr MD release check runs on x64 Linux only' };
  const dir = join(prefix, MD_RELEASE.dir);
  mkdirSync(dir, { recursive: true });
  const meta = await run('curl', ['-fsSL', `https://api.github.com/repos/${MD_RELEASE.repo}/releases/latest`], { env: process.env, timeoutMs });
  if (meta.code !== 0) return { reason: `could not read the latest Ashlr MD release (curl exit ${meta.code})` };
  let release;
  try { release = JSON.parse(meta.stdout); } catch { return { reason: 'the Ashlr MD release listing is not JSON' }; }
  const asset = (release.assets ?? []).find(a => /_amd64\.deb$/.test(a.name));
  if (!asset) return { reason: `Ashlr MD ${release.tag_name ?? 'latest'} ships no amd64 .deb` };
  const deb = join(dir, asset.name);
  const download = await run('curl', ['-fsSL', '-o', deb, asset.browser_download_url], { env: process.env, timeoutMs });
  if (download.code !== 0) return { reason: `could not download ${asset.name} (curl exit ${download.code})` };
  const unpack = await run('dpkg-deb', ['-x', deb, join(dir, 'root')], { env: process.env, timeoutMs });
  if (unpack.code !== 0) return { reason: `could not unpack ${asset.name} (dpkg-deb exit ${unpack.code})` };
  return { version: String(release.tag_name ?? '').replace(/^v/, '') || null };
}

/** Install the published packages into `prefix` (network). Scripts stay off. */
export async function installPublished(prefix, { timeoutMs = 300_000 } = {}) {
  mkdirSync(prefix, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await run(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts',
    '--no-save', ...PUBLISHED_PACKAGES.map(pkg => `${pkg.name}@latest`)], { env: process.env, cwd: prefix, timeoutMs });
  if (result.code !== 0) throw new Error(`npm install failed (exit ${result.code}): ${result.stderr.trim().slice(-400)}`);
}

/**
 * Resolve smoke options from an installed prefix (pure filesystem, no network).
 * Explicit options win; anything unresolved gets a skip reason naming the gap.
 */
export function resolvePublished(prefix, explicit = {}) {
  const options = {}, skipReasons = {}, packages = [];
  const binDir = join(prefix, 'node_modules', '.bin');
  for (const pkg of PUBLISHED_PACKAGES) {
    const root = join(prefix, 'node_modules', ...pkg.name.split('/'));
    let version = null;
    try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch { /* not installed */ }
    packages.push({ name: pkg.name, version });
    const entries = [
      ...Object.entries(pkg.bins ?? {}).map(([key, bin]) => [key, join(binDir, process.platform === 'win32' ? `${bin}.cmd` : bin), `bin ${bin}`]),
      ...Object.entries(pkg.files ?? {}).map(([key, file]) => [key, join(root, file), file]),
    ];
    for (const [key, path, label] of entries) {
      if (explicit[key]) continue;
      if (version && existsSync(path)) options[key] = path;
      else skipReasons[key] = version ? `${pkg.name}@${version} ships no ${label}` : `${pkg.name} is not installed`;
    }
  }
  const md = explicit.mdRelease ?? { reason: 'Ashlr MD release was not installed' };
  const libDir = join(prefix, MD_RELEASE.dir, 'root', ...MD_RELEASE.libDir);
  packages.push({ name: `${MD_RELEASE.repo} (GitHub release)`, version: md.version ?? null });
  for (const [key, bin] of Object.entries(MD_RELEASE.bins)) {
    if (explicit[key]) continue;
    const path = join(libDir, bin);
    if (md.version && existsSync(path)) options[key] = path;
    else skipReasons[key] = md.version ? `Ashlr MD ${md.version} release ships no ${bin}` : md.reason;
  }
  return { options, skipReasons, packages };
}

/**
 * Run each npm wrapper once in the sandbox so it downloads its native release,
 * then pick up the MCP server that came with it. Returns per-option skip reasons.
 */
export async function materializeNative(options, env, home) {
  const skipReasons = {};
  for (const pkg of PUBLISHED_PACKAGES) {
    if (!pkg.native) continue;
    const cliKey = Object.keys(pkg.bins)[0];
    let warm = null;
    for (const [key, parts] of Object.entries(pkg.native)) {
      if (options[key]) continue;
      if (!options[cliKey]) { skipReasons[key] = `${pkg.name} CLI not resolved`; continue; }
      warm ??= await run(options[cliKey], ['--version'], { env, cwd: home, timeoutMs: 60_000 });
      const path = join(home, ...parts);
      if (existsSync(path)) { options[key] = path; continue; }
      const lastLine = warm.stderr.trim().split('\n').filter(line => !/^Downloading /u.test(line))[0] ?? '';
      skipReasons[key] = warm.code === 0
        ? `the ${pkg.name} wrapper installs no ${parts.at(-1)}`
        : `the ${pkg.name} wrapper failed (${warm.timedOut ? 'no exit within 60 s' : `exit ${warm.code}`})${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}`;
    }
  }
  return skipReasons;
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
    // Trust roots only (file paths, not credentials), so npm wrappers can download behind a TLS proxy.
    ...pick(process.env, ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key]).map(key => [key, source[key]]));
}

/** POSIX: own process group, so a timeout kills grandchildren that hold stdout too. */
const DETACH = process.platform !== 'win32';
/** How long to wait for stdio to close after the child itself exited. */
const CLOSE_GRACE_MS = 500;

function killTree(child) {
  if (DETACH && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function releaseStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
}

/** Run to completion with a hard bound; a hang is reported, never waited on. */
export function run(path, args, { env, cwd, input, timeoutMs = 20_000 } = {}) {
  const [cmd, argv] = commandFor(path, args);
  return new Promise(resolvePromise => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false, settled = false, graceTimer;
    let child;
    try {
      child = spawn(cmd, argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: DETACH });
    } catch (error) {
      resolvePromise({ code: null, stdout, stderr: String(error), timedOut, ms: 0 });
      return;
    }
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolvePromise({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', error => { stderr += `stdin: ${String(error)}`; });
    child.on('error', error => { stderr += String(error); });
    // A grandchild that inherited stdout can keep 'close' from ever firing.
    child.on('exit', code => {
      graceTimer = setTimeout(() => { releaseStdio(child); finish(code); }, CLOSE_GRACE_MS);
    });
    child.on('close', code => finish(code));
    child.stdin.end(input ?? '');
  });
}

/**
 * Minimal newline-delimited JSON-RPC client for a stdio MCP server: initialize,
 * notifications/initialized, tools/list. Non-JSON on stdout is a protocol break.
 */
export async function mcpHandshake(path, { env, cwd, protocolVersion, timeoutMs = 20_000, args = [], call }) {
  const [cmd, argv] = commandFor(path, args);
  const child = spawn(cmd, argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: DETACH });
  const pending = new Map();
  const noise = [];
  let buffer = '', stderr = '', nextId = 0, exited = null;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { exited = String(error); for (const fail of pending.values()) fail.reject(new Error(exited)); });
  // A server that exits before reading stdin turns the next write into EPIPE.
  child.stdin.on('error', error => {
    exited ??= `stdin ${String(error)}`;
    for (const fail of pending.values()) fail.reject(new Error(`server ${exited}: ${stderr.trim().slice(-300)}`));
  });
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
    // One optional tools/call, for a server whose real work is worth a seam check.
    const called = call ? await request('tools/call', call) : undefined;
    return {
      serverInfo: init.result?.serverInfo ?? null,
      protocolVersion: init.result?.protocolVersion ?? null,
      tools: (list.result?.tools ?? []).map(tool => tool.name),
      ...(call ? { call: called } : {}),
      noise,
    };
  } finally {
    killTree(child);
    releaseStdio(child);
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
  const reasons = { ...(options.skipReasons ?? {}) };
  const why = (key, fallback) => reasons[key] ?? fallback;
  const box = sandbox();
  try {
    const env = smokeEnv(box.home, [options.stackBin, options.secretsBin].filter(Boolean).map(dirname));
    if (options.published) Object.assign(reasons, await materializeNative(options, env, box.home));

    // 1. Phantom identifies each installed companion it has a reviewed contract for.
    const companionFlags = [['secrets', 'secretsBin'], ['locus', 'locusBin'], ['lexicon', 'lexiconBin']]
      .filter(([, key]) => present(key));
    if (!present('phm')) skip('phm:companions', why('phm', 'no --phm'));
    else if (!companionFlags.length) skip('phm:companions', 'no companion CLI given');
    else {
      const args = ['companions', '--json', '--bin-dir', box.root];
      // A published npm wrapper is a bootstrap launcher; phm probes the native binary it installed.
      for (const [id, key] of companionFlags) args.push(`--${id}-bin`, options[`${key}Native`] ?? options[key]);
      const result = await run(options.phm, args, { env, cwd: box.home });
      if (result.code !== 0) add('phm:companions', { status: 'fail', detail: `exit ${result.code}: ${result.stderr.trim().slice(0, 200)}` });
      else {
        const report = JSON.parse(result.stdout);
        for (const [id, key] of companionFlags) {
          const entry = report.companions.find(item => item.id === id);
          const check = entry ? evaluateCompanion(entry) : { status: 'fail', detail: 'not in report' };
          const native = reasons[`${key}Native`];
          if (check.status === 'fail' && native && !options[`${key}Native`]) check.detail += `; no native binary to probe: ${native}`;
          add(`phm:companions:${id}`, check);
        }
      }
    }

    // 2. Every MCP server completes the handshake current clients send.
    for (const server of MCP_SERVERS) {
      if (!present(server.option)) { skip(`${server.id}:mcp`, why(server.option, `no --${server.option.replace(/[A-Z]/gu, c => `-${c.toLowerCase()}`)}`)); continue; }
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
    if (!present('phm') || !present('stackBin')) skip('phm:stack-status', why('stackBin', why('phm', 'needs --phm and --stack-bin')));
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
    if (!present('lexiconHook')) skip('lexicon:hook', why('lexiconHook', 'no --lexicon-hook'));
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
    if (!present('mdopen')) skip('md:mdopen', why('mdopen', 'no --mdopen'));
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
    if (!present('locusBin')) skip('locus:pin-report', why('locusBin', 'no --locus-bin'));
    else if (process.platform === 'win32') skip('locus:pin-report', 'needs a POSIX shell for the pin hook');
    else if (!existsSync(locusDist)) skip('locus:pin-report', 'Phantom dist not built (npm run build)');
    else {
      for (const [id, check] of await locusPinReport(options.locusBin, locusDist, env, box.home)) add(id, check);
    }

    // 7. Secrets: a project secret reaches an upstream only through `phantom exec`'s proxy.
    if (!present('secretsBin')) skip('secrets:exec-proxy', why('secretsBin', 'no --secrets-bin'));
    else add('secrets:exec-proxy', await secretsExecProxy(options.secretsBin, env, box.home));

    // 8. Ashlr.AI Plugin: its MCP router completes the handshake and ashlr__grep finds a
    // match in the project Claude Code names (CLAUDE_PROJECT_DIR), via an explicit cwd.
    if (!present('pluginDir')) skip(`${PLUGIN_SERVER.id}:mcp`, why('pluginDir', 'no --plugin-dir'));
    else for (const [id, check] of await pluginRouter(options.pluginDir, env, box.home)) add(id, check);

    // 9. Locus resolves a binding's `phm:` credential through Phantom Secrets into
    // `locus exec`'s child (the composition both products document), and an `env:` control.
    if (!present('locusBin') || !present('secretsBin')) skip('locus:phm-credential', why('locusBin', why('secretsBin', 'needs --locus-bin and --secrets-bin')));
    else if (process.platform === 'win32') skip('locus:phm-credential', 'needs a POSIX shell for the pin hook');
    else for (const [id, check] of await locusPhmCredential(options, env, box)) add(id, check);

    // 10. Cortex's hosted MCP endpoint is up and challenges an anonymous or unknown token
    // the way MCP clients expect (401 + Bearer), without echoing the token.
    if (!options.cortexUrl) skip('cortex:mcp-auth', 'no --cortex-url');
    else add('cortex:mcp-auth', await cortexMcpAuth(options.cortexUrl));

    // 11. Stack reads the Phantom Secrets vault of a project (as its CLI and as its MCP tools):
    // stored names count, declared-but-missing names are reported, and no value is printed.
    if (!present('stackBin') || !present('secretsBin')) skip('stack:phantom-vault', why('stackBin', why('secretsBin', 'needs --stack-bin and --secrets-bin')));
    else if (process.platform === 'win32') skip('stack:phantom-vault', 'needs a POSIX PATH shim for `phantom`');
    else for (const [id, check] of await stackPhantomVault(options, env, box)) add(id, check);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
  return {
    schema: SMOKE_SCHEMA, ok: checks.every(check => check.status !== 'fail'), checks,
    ...(options.packages ? { published: { prefix: options.prefix ?? null, packages: options.packages } } : {}),
  };
}

const PLUGIN_NEEDLE = 'phm_plugin_smoke_needle';

/** The plugin's router over stdio: handshake for each client version, then one ashlr__grep. */
export async function pluginRouter(pluginDir, env, home) {
  const entry = join(pluginDir, ...PLUGIN_SERVER.entry);
  if (!existsSync(entry)) return [[`${PLUGIN_SERVER.id}:mcp`, { status: 'fail', detail: `no ${PLUGIN_SERVER.entry.join('/')} in ${pluginDir}` }]];
  const project = join(home, 'plugin-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'smoke.py'), `${PLUGIN_NEEDLE} = 1\n`);
  // The bootstrap never installs Bun here; a missing Bun is a failed check, not a download.
  const pluginEnv = { ...env, CLAUDE_PROJECT_DIR: project, ASHLR_NO_AUTO_INSTALL: '1' };
  const results = [];
  for (const [index, protocolVersion] of CLIENT_PROTOCOL_VERSIONS.entries()) {
    const call = index === 0
      ? { name: 'ashlr__grep', arguments: { pattern: PLUGIN_NEEDLE, cwd: project } }
      : undefined;
    try {
      const result = await mcpHandshake(entry, { env: pluginEnv, cwd: project, protocolVersion, args: PLUGIN_SERVER.args, call, timeoutMs: 45_000 });
      results.push([`${PLUGIN_SERVER.id}:mcp:${protocolVersion}`, evaluateHandshake(PLUGIN_SERVER, protocolVersion, result)]);
      if (call) results.push([`${PLUGIN_SERVER.id}:grep`, evaluatePluginGrep(result.call)]);
    } catch (error) {
      results.push([`${PLUGIN_SERVER.id}:mcp:${protocolVersion}`, { status: 'fail', detail: error instanceof Error ? error.message : String(error) }]);
    }
  }
  return results;
}

/** Presence of the match is the contract; the output shape is still changing upstream. */
export function evaluatePluginGrep(message) {
  if (message?.error) return { status: 'fail', detail: `tools/call error: ${JSON.stringify(message.error).slice(0, 200)}` };
  const text = (message?.result?.content ?? []).map(part => part?.text ?? '').join('\n');
  // Needle and file name both: an error or 'no matches' message may echo the pattern.
  if (message?.result?.isError || !text.includes(PLUGIN_NEEDLE) || !text.includes('smoke.py')) return { status: 'fail', detail: `no match returned: ${text.trim().slice(0, 200) || 'empty result'}` };
  return { status: 'pass', detail: `ashlr__grep found the match (${text.length} chars)` };
}

/** `--published`: install (into a temp prefix unless --prefix), resolve, run, clean up. */
export async function runPublishedSmoke(options) {
  const prefix = options.prefix ?? mkdtempSync(join(tmpdir(), 'phm-companion-published-'));
  try {
    await installPublished(prefix);
    const mdRelease = options.mdopen && options.mdopenerMcp ? undefined : await installMdRelease(prefix);
    const resolved = resolvePublished(prefix, { ...options, mdRelease });
    return await runSmoke({ ...resolved.options, ...stripUndefined(options),
      skipReasons: resolved.skipReasons, packages: resolved.packages });
  } finally {
    if (!options.prefix) rmSync(prefix, { recursive: true, force: true });
  }
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
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
    return [['locus:pin-report', { status: 'fail', detail: `pin flow ${result.timedOut ? 'did not finish within 30 s' : `exit ${result.code}`}: ${result.stderr.trim().slice(-200)}` }]];
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

/** `phantom init --empty`, then each value over stdin (never argv), in `project`. */
async function secretsProject(secretsBin, env, project, entries) {
  mkdirSync(project, { recursive: true });
  const init = await run(secretsBin, ['init', '--empty'], { env, cwd: project });
  if (init.code !== 0) return `phantom init --empty exit ${init.code}: ${init.stderr.trim().slice(0, 200)}`;
  for (const [name, value] of entries) {
    const add = await run(secretsBin, ['add', name, '--stdin'], { env, cwd: project, input: value });
    if (add.code !== 0) return `phantom add --stdin exit ${add.code}: ${add.stderr.trim().slice(0, 200)}`;
  }
  return null;
}

/**
 * Stack calls `phantom` from PATH for everything vault-related. With one secret of
 * three declared in `.stack.toml` stored, Stack must count it, name exactly the two
 * missing ones, and never print the value: through `stack` and through `stack-mcp`.
 */
export async function stackPhantomVault(options, env, box) {
  const project = join(box.home, 'stack-vault-project');
  const shim = join(box.root, 'phantom-shim');
  mkdirSync(shim, { recursive: true });
  symlinkSync(options.secretsBin, join(shim, 'phantom'));
  const vaultEnv = { ...env, PATH: [shim, env.PATH].join(delimiter), PHANTOM_VAULT_PASSPHRASE: 'phm-companion-smoke-passphrase' };
  const setup = await secretsProject(options.secretsBin, vaultEnv, project, [['OPENAI_API_KEY', SECRET_SENTINEL]]);
  if (setup) return [['stack:phantom-vault', { status: 'fail', detail: setup }]];
  writeFileSync(join(project, '.stack.toml'), STACK_TOML);
  const leaked = (...texts) => texts.some(text => typeof text === 'string' && text.includes(SECRET_SENTINEL));
  const checks = [];

  const status = await run(options.stackBin, ['status', '--json'], { env: vaultEnv, cwd: project, timeoutMs: 30_000 });
  let report = null;
  try { report = JSON.parse(status.stdout); } catch { /* reported below */ }
  const count = report?.phantom?.secret_count;
  checks.push(['stack:phantom-vault', leaked(status.stdout, status.stderr)
    ? { status: 'fail', detail: 'stack status printed the stored value' }
    : report?.phantom?.installed === true && count === 1
      ? { status: 'pass', detail: 'stack status --json found Phantom and counted the 1 stored secret' }
      : { status: 'fail', detail: report ? `phantom ${JSON.stringify(report.phantom ?? null)}, expected installed with secret_count 1` : `stack status --json exit ${status.code}: not JSON` }]);

  const diff = await run(options.stackBin, ['env', 'diff'], { env: vaultEnv, cwd: project, timeoutMs: 30_000 });
  checks.push(['stack:env-diff', evaluateEnvDiff(diff.stdout + diff.stderr, `exit ${diff.code}`)]);

  if (!options.stackMcp || !existsSync(options.stackMcp)) checks.push(['stack:mcp-env-diff', { status: 'skip', detail: 'no --stack-mcp' }]);
  else {
    try {
      const result = await mcpHandshake(options.stackMcp, { env: vaultEnv, cwd: project,
        protocolVersion: CLIENT_PROTOCOL_VERSIONS[0], call: { name: 'stack_env_diff', arguments: {} }, timeoutMs: 30_000 });
      const text = (result.call?.result?.content ?? []).map(part => part?.text ?? '').join('\n');
      checks.push(['stack:mcp-env-diff', result.call?.error
        ? { status: 'fail', detail: `tools/call error: ${JSON.stringify(result.call.error).slice(0, 200)}` }
        : evaluateEnvDiff(text, 'stack_env_diff')]);
    } catch (error) {
      checks.push(['stack:mcp-env-diff', { status: 'fail', detail: error instanceof Error ? error.message : String(error) }]);
    }
  }
  return checks;
}

const CREDENTIAL_PROBE = `const { createHash } = await import('node:crypto');
const token = process.env.GH_TOKEN ?? '';
const seen = !token ? 'unset' : createHash('sha256').update(token).digest('hex') === process.argv[1] ? 'match' : 'different';
process.stdout.write('PHM_SMOKE_CRED ' + seen + '\\n');`;

/**
 * A github binding whose credential_ref is `phm:NAME` (and, as a control, `env:NAME`),
 * pinned and run with `locus exec --strict-creds`: the child must get the stored value
 * as GH_TOKEN. Only its sha256 is passed in argv, because Locus audits exec argv.
 */
export async function locusPhmCredential(options, env, box) {
  const project = join(box.home, 'locus-credential-project');
  const shim = join(box.root, 'locus-phantom-shim');
  mkdirSync(shim, { recursive: true });
  symlinkSync(options.secretsBin, join(shim, 'phantom'));
  const credEnv = { ...env, PATH: [shim, dirname(options.locusBin), env.PATH].join(delimiter),
    PHANTOM_VAULT_PASSPHRASE: 'phm-companion-smoke-passphrase',
    // Its own Locus home: the pin-report check already initialised the default one.
    LOCUS_HOME: join(box.home, '.locus-credential') };
  const setup = await secretsProject(options.secretsBin, credEnv, project, [['GH_SMOKE_TOKEN', SECRET_SENTINEL]]);
  if (setup) return [['locus:phm-credential', { status: 'fail', detail: setup }]];
  const hash = createHash('sha256').update(SECRET_SENTINEL).digest('hex');
  const probe = (label, ref) => [
    `locus binding add ${label} --tenant ${label} --provider github --account ${label}-gh --credential-ref ${ref} --org smoke-org --non-interactive >/dev/null`,
    `locus enter ${label} --force >/dev/null`,
    `echo "PHM_SMOKE_STEP ${label}"`,
    `locus exec --strict-creds -- "$PHM_SMOKE_NODE" --input-type=module -e "$PHM_SMOKE_PROBE" ${hash} 2>&1 || echo "PHM_SMOKE_EXIT $?"`,
    'locus leave --force >/dev/null 2>&1 || true',
  ];
  const script = [
    'set -e',
    'locus init >/dev/null 2>&1',
    'eval "$(locus hook bash)"',
    'set +e',
    ...probe('phmcred', 'phm:GH_SMOKE_TOKEN'),
    ...probe('envcred', 'env:PHM_SMOKE_ENV_TOKEN'),
    'exit 0',
  ].join('\n');
  const result = await run('bash', ['-c', script], { cwd: project, timeoutMs: 60_000,
    env: { ...credEnv, PHM_SMOKE_NODE: process.execPath, PHM_SMOKE_PROBE: CREDENTIAL_PROBE, PHM_SMOKE_ENV_TOKEN: SECRET_SENTINEL } });
  const output = (result.stdout + result.stderr).replaceAll(SECRET_SENTINEL, '<value>');
  if (result.code !== 0 || !output.includes('PHM_SMOKE_STEP envcred')) {
    return [['locus:phm-credential', { status: 'fail', detail: `binding flow ${result.timedOut ? 'did not finish within 60 s' : `exit ${result.code}`}: ${output.trim().slice(-200)}` }]];
  }
  const [phm, envSection] = output.split('PHM_SMOKE_STEP envcred');
  return [
    ['locus:phm-credential', evaluateLocusCredential(phm, 'phm:', result.stdout + result.stderr)],
    ['locus:env-credential', evaluateLocusCredential(envSection, 'env:', result.stdout + result.stderr)],
  ];
}

/** One `locus exec --strict-creds` section of the binding flow's output. */
export function evaluateLocusCredential(section, scheme, raw = '') {
  if (raw.includes(SECRET_SENTINEL)) return { status: 'fail', detail: 'the stored value was printed' };
  const seen = section.match(/PHM_SMOKE_CRED (\w+)/u)?.[1];
  if (seen === 'match') return { status: 'pass', detail: `the ${scheme} credential_ref reached the locus exec child as GH_TOKEN` };
  const reason = section.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('PHM_SMOKE')).at(-1) ?? '';
  return { status: 'fail', detail: `the ${scheme} credential ${seen ? `reached the child as ${seen}` : 'did not resolve'}${reason ? `: ${reason.slice(0, 200)}` : ''}` };
}

/** Cortex's JSON-RPC code for an unauthenticated MCP request (packages/api/src/mcp/http.ts). */
const CORTEX_UNAUTHORIZED = -32001;

/**
 * Two requests, no credential: an anonymous `initialize` and one with a well-formed
 * but unknown `ctx_pat_` token. Cortex attests its database before authenticating,
 * so a 401 with a Bearer challenge also shows the deployment can verify tokens; a 503
 * is its "no database" refusal.
 */
export async function cortexMcpAuth(url, { timeoutMs = 20_000 } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: CLIENT_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'phm-companion-smoke', version: '1' } } });
  const fake = `ctx_pat_${randomBytes(32).toString('base64url').slice(0, 43)}`;
  const problems = [];
  for (const [label, token] of [['anonymous', null], ['unknown token', fake]]) {
    let response, text;
    try {
      response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      text = await response.text();
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message;
      return { status: 'fail', detail: `${label} request to ${url} failed: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ''}` };
    }
    problems.push(...evaluateCortexChallenge(label, response.status, response.headers, text, token));
  }
  return problems.length
    ? { status: 'fail', detail: problems.join('; ').slice(0, 300) }
    : { status: 'pass', detail: 'anonymous and unknown-token requests got 401 with a Bearer challenge' };
}

export function evaluateCortexChallenge(label, status, headers, text, token) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* reported below */ }
  if (status === 503) return [`${label}: 503 ${parsed?.error?.message ?? 'service unavailable'}`];
  const problems = [];
  if (status !== 401) problems.push(`${label}: HTTP ${status}, expected 401`);
  else {
    if (parsed?.error?.code !== CORTEX_UNAUTHORIZED) problems.push(`${label}: body is not a JSON-RPC ${CORTEX_UNAUTHORIZED} error`);
    if (!/^Bearer\b/iu.test(headers.get('www-authenticate') ?? '')) problems.push(`${label}: no Bearer challenge`);
    if (!/no-store/iu.test(headers.get('cache-control') ?? '')) problems.push(`${label}: 401 is cacheable`);
  }
  if (token && text.includes(token)) problems.push(`${label}: response echoed the token`);
  return problems;
}

/** Stack's env diff for the smoke project: the two Supabase names, never the stored one or its value. */
export function evaluateEnvDiff(text, label) {
  if (text.includes(SECRET_SENTINEL)) return { status: 'fail', detail: `${label} printed the stored value` };
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter(name => !text.includes(name));
  const problems = [];
  if (missing.length) problems.push(`did not report missing ${missing.join(', ')}`);
  if (text.includes('OPENAI_API_KEY')) problems.push('reported the stored OPENAI_API_KEY as missing');
  return problems.length
    ? { status: 'fail', detail: `${label}: ${problems.join('; ')}: ${text.trim().slice(0, 200)}` }
    : { status: 'pass', detail: `${label} named the 2 missing secrets and not the stored one` };
}

function printHuman(report) {
  for (const pkg of report.published?.packages ?? []) process.stdout.write(`pkg  ${pkg.name}@${pkg.version ?? 'not installed'}\n`);
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
  let report;
  try { report = options.published ? await runPublishedSmoke(options) : await runSmoke(options); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);
  process.exit(report.ok ? 0 : 1);
}

