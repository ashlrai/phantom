/**
 * Regression guard: `phm <cmd> [verb] --help` and `-h` print usage and do
 * nothing else.
 *
 * On master several commands executed instead of explaining themselves:
 * `fleet pause --help` engaged the kill switch, `gh pr create --help` opened a
 * real PR, `worker setup --help` ran setup. Those instances were fixed one by
 * one; this file guards the whole bug class.
 *
 * Cases are enumerated from the CLI's own registry, never from a list kept
 * here: the test asks the CLI for `completions bash` (generated from
 * TOP_LEVEL_COMMANDS and the per-command verb table in src/cli/completions.ts,
 * which test/cli-registry-drift.test.ts keeps in sync with the dispatcher) and
 * parses the top-level commands, every first-position verb and the
 * third-position verb table. A new command or verb is covered as soon as it is
 * completable. Flag-shaped completion words and the `help` verb (itself a help
 * alias) are not verbs and are skipped.
 *
 * Every case runs in its own spawned CLI process, so the isolation is real:
 *   - a fresh sandbox HOME / ASHLR_HOME / XDG_* tree (an initialized home: the
 *     default config.json is bootstrapped once, so a `--help` that rewrites it
 *     is still caught) and a fresh cwd that is a git checkout with a GitHub
 *     origin, so a command that would act really reaches its git/gh calls;
 *   - both trees must be byte-identical afterwards;
 *   - a minimal environment: no GH/GitHub/provider tokens, HTTP(S)_PROXY and
 *     ALL_PROXY pointed at a closed localhost port (NODE_USE_ENV_PROXY=1);
 *   - PATH starts with `gh`, `git` and `curl` shims that record any call and
 *     fail; a recorded call is a side effect;
 *   - a `--import` preload in the child records every TCP connect (and
 *     redirects it to the closed port, so nothing leaves the machine) and every
 *     child_process call (gh/git/curl are routed to the shims even by absolute
 *     path, anything else to an inert stub that exits 97, so a misbehaving
 *     command cannot touch the developer's real services). Any record is a side
 *     effect.
 *
 * Contract per case: exit 0, usage text on stdout or stderr, no side effect.
 *
 * HELP_STRICT_REFUSALS is the documented allow-list of commands whose argument
 * grammar is intentionally strict: they answer `--help` with their usage and
 * exit 2. They must still show usage and have no side effect.
 *
 * KNOWN_HELP_ACTS lists cases that still do not honor `--help` even with the
 * help-safety fixes merged. Each entry is asserted to STILL violate the
 * contract, so the list can only shrink: when a command is fixed this test
 * fails until its entry is deleted. Entries not in KNOWN_HELP_SIDE_EFFECTS are
 * still held to the no-side-effect assertion; entries in it are asserted to
 * still show their effect, so that list can only shrink too.
 *
 * Speed: the cases run concurrently from one beforeAll. CI builds dist/ before
 * the hermetic tests, so the compiled entry is used when every src module has
 * an up-to-date dist/ counterpart (about 45s for ~750 cases on 4 cores).
 * Otherwise (a local edit without a rebuild) the source entry runs through tsx,
 * which is correct but about three times slower.
 *
 * POSIX only: the PATH shims are shell scripts.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';
const FLAGS = ['--help', '-h'] as const;

// ---------------------------------------------------------------------------
// Documented exceptions
// ---------------------------------------------------------------------------
// Keys are the argv without the flag (applies to both `--help` and `-h`) or the
// full argv (applies to that flag only).

const STRICT_VERB_PARSER = 'its option parser turns every unrecognized flag, --help included, into a usage error: full usage on stderr, exit 2, before any store, provider or network access';

/** Intentionally strict: exit 2 with usage, no side effects (still asserted). */
const HELP_STRICT_REFUSALS: Record<string, string> = {
  'config set': '`config set` takes exactly <key> <value>; anything else prints its usage line and exits 2 before the config is touched',
  team: 'the team dispatcher prints its Usage for anything that is not one of its verbs (src/cli/team.ts) and exits 2',
  steward: '`steward` only has the `disk` verb; anything else prints its Usage line and exits 2 (src/cli/steward.ts)',
  improve: '`improve` only has the `propose` verb; anything else prints its Usage line and exits 2 (src/cli/improve.ts)',
  'mcp install': 'install requires an explicit client target and refuses with its usage before reading or writing any client config',
  'desktop install': 'release installer with an exact grammar; an unrecognized token is a usage error before any download or stage',
  'desktop-update inspect': 'release updater with an exact grammar; an unrecognized token is a usage error before any stage is read',
  'desktop-update apply': 'release updater with an exact grammar; an unrecognized token is a usage error before any stage is applied',
  website: 'website publication is authority-bearing and takes an exact grammar; an unknown verb prints its usage and exits 2',
  'website run': 'website publication verbs accept only their exact arguments; anything else prints usage and exits 2 with no state written',
  'website prepare': 'prepare requires --image <sha256:digest>; anything else prints usage and exits 2 with no state written',
  'website commission': 'commission requires an explicit --yes; anything else prints usage and exits 2 with no state written',
  'fleet automerge-canary status': 'auto-merge canary custody verbs accept only their exact flags; anything else prints the canary usage and exits 2',
  'fleet automerge-canary halt': 'auto-merge canary custody verbs accept only their exact flags; anything else prints the canary usage and exits 2',
  'fleet automerge-canary reconcile': 'auto-merge canary custody verbs accept only their exact flags; anything else prints the canary usage and exits 2',
  'recovery list': 'list accepts only --json; anything else prints its usage line and exits 2',
  'stack add --help': 'add requires <service>; a flag is refused with its usage line before the stack binary is looked up',
  'plugins init --help': 'init requires a plugin <name>; a flag is refused with its usage line before anything is scaffolded',
  skills: '`skills` only has the `audit` verb; anything else prints its Usage and exits 2',
  'skills audit': 'audit requires <pack-path>; a flag is refused with its Usage before any pack is read',
  'local-runtime status': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime start': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime stop': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime restart': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime reshape': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime install': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime uninstall': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime logs': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'local-runtime resolve-model': `parseFlags in src/cli/local-runtime.ts: ${STRICT_VERB_PARSER}`,
  'cloud launch --help': `src/cli/cloud.ts UsageError: ${STRICT_VERB_PARSER}`,
  'cloud list': `src/cli/cloud.ts UsageError: ${STRICT_VERB_PARSER}`,
  'cloud refresh': `src/cli/cloud.ts UsageError: ${STRICT_VERB_PARSER}`,
  'cloud improve': `src/cli/cloud.ts UsageError: ${STRICT_VERB_PARSER}`,
  'cloud budget': `src/cli/cloud.ts UsageError: ${STRICT_VERB_PARSER}`,
  'cloud backlog': `src/cli/cloud.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin connect': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin disconnect': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin seat': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin enable': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin disable': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin fleet': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin status': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin launch --help': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin list': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin refresh': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin message': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'devin budget': `src/cli/devin.ts UsageError: ${STRICT_VERB_PARSER}`,
  'openai-agents sessions': `read-only inventory with an exact option grammar: ${STRICT_VERB_PARSER}`,
  'openai-agents inspect': `read-only inventory with an exact option grammar: ${STRICT_VERB_PARSER}`,
  'openai-agents turns': `read-only inventory with an exact option grammar: ${STRICT_VERB_PARSER}`,
  'automations list': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'automations templates --help': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'automations add': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'automations enable --help': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'automations disable --help': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'automations remove --help': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'automations fire --help': `src/cli/automations.ts UsageError: ${STRICT_VERB_PARSER}`,
  'jev status': '`jev status` rejects unexpected arguments with a UsageError (src/cli/jev.ts): usage, exit 2',
  'wiki ask --help': 'ask requires "<question>"; a flag is refused with its Usage line before any wiki, index or model is read',
  'playbook list --help': `src/cli/playbook.ts UsageError: ${STRICT_VERB_PARSER}`,
  'playbook show': `src/cli/playbook.ts UsageError: ${STRICT_VERB_PARSER}`,
  'playbook new': `src/cli/playbook.ts UsageError: ${STRICT_VERB_PARSER}`,
  'playbook edit': `src/cli/playbook.ts UsageError: ${STRICT_VERB_PARSER}`,
  'playbook run': `src/cli/playbook.ts UsageError: ${STRICT_VERB_PARSER}`,
};

/**
 * Still broken with the help-safety fixes merged: the command runs (or treats
 * the flag as an operand) instead of printing usage. Asserted to STILL violate
 * the contract; delete an entry when its command is fixed. Value: what it does.
 */
const KNOWN_HELP_ACTS: Record<string, string> = {
  index: 'exit 0: builds and prints the index',
  go: 'exit 1: builds the index, then "Nothing selected."',
  status: 'exit 0: builds the index and prints portfolio status',
  'ls --help': 'exit 0: builds the index and lists it',
  'ls -h': 'exit 1: builds the index, then treats -h as a category',
  open: 'exit 1: builds the index, then "Nothing selected."',
  tidy: 'exit 0: runs the Desktop tidy plan ("Nothing to tidy.")',
  config: 'exit 0: prints the config',
  'config get': 'exit 1: looks the flag up as a config key',
  'config path': 'exit 0: prints the config path',
  doctor: 'exit 1: runs the full doctor (probes PATH, git, local models)',
  init: 'exit 1: runs init (installs ~/.local/bin/ashlr, seeds genome, probes models)',
  setup: 'exit 1: runs the setup preflight ("setup incomplete")',
  'mcp list': 'exit 0: discovers and lists MCP servers',
  'mcp doctor': 'exit 0: probes MCP servers',
  'mcp ecosystem': 'exit 0: scans PATH for ecosystem MCP servers',
  'mcp run': 'exit 13: starts the MCP aggregation gateway on stdio',
  'run show': 'exit 1: looks the flag up as a run id',
  runs: 'exit 0: lists past runs',
  'pulse-test': 'exit 2: runs the pulse check ("not configured"), no usage',
  swarms: 'exit 0: lists swarms',
  'models list': 'exit 0: probes Ollama / LM Studio and lists models',
  'models pull': 'exit 2: "pull requires a model name", no usage',
  'models start': 'exit 1: looks for ollama to start it',
  'vercel ls': 'exit 0: looks for a linked Vercel project',
  'vercel logs': 'exit 0: looks for a linked Vercel deployment',
  'website status': 'exit 0: prints the publication state',
  'website auto': 'exit 1: tries to enable Auto publication',
  'website pause': 'exit 0: records website publication as paused',
  'website off': 'exit 0: records website publication as off',
  'website request': 'exit 1: treats the flag as a merge revision',
  'wire claude --help': 'exit 2: "unknown flag: --help", no usage',
  'wire claude -h': 'exit 2: "unexpected argument: -h", no usage',
  'wire codex --help': 'exit 2: "unknown flag: --help", no usage',
  'wire codex -h': 'exit 2: "unexpected argument: -h", no usage',
  'wire cursor --help': 'exit 2: "unknown flag: --help", no usage',
  'wire cursor -h': 'exit 2: "unexpected argument: -h", no usage',
  'wire all --help': 'exit 2: "unknown flag: --help", no usage',
  'wire all -h': 'exit 2: "unexpected argument: -h", no usage',
  'inbox submit': 'exit 0: runs submit and prints "undefined"',
  'fleet automerge-canary prepare-shadow': 'exit 2: "unknown, duplicate, or valueless preparation option", no usage',
  'fleet automerge-canary activate-shadow': 'exit 2: "unknown, duplicate, or valueless activation option", no usage',
  'recovery inspect': 'exit 2: "requires an exact 64-character effect id", no usage',
  'recovery attest': 'exit 2: "requires an exact 64-character effect id", no usage',
  'recovery abandon': 'exit 2: "requires an exact 64-character effect id", no usage',
  'stack status': 'exit 1: looks for the stack binary',
  'stack list': 'exit 1: looks for the stack binary',
  'stack providers': 'exit 1: looks for the stack binary',
  'stack recommend': 'exit 1: looks for the stack binary',
  'stack scan': 'exit 1: looks for the stack binary',
  'stack doctor': 'exit 1: looks for the stack binary',
  'stack add -h': 'exit 1: treats -h as a service and looks for the stack binary',
  'stack apply': 'exit 1: looks for the stack binary',
  'completions zsh': 'exit 0: prints the zsh completion script',
  'completions bash': 'exit 0: prints the bash completion script',
  'plugins init -h': 'exit 2: validates -h as a plugin name, no usage',
  'plugins list': 'exit 0: lists plugins',
  'plugins info': 'exit 1: looks the flag up as a plugin name',
  'plugins enable': 'exit 1: looks the flag up as a plugin name',
  'plugins disable': 'exit 1: looks the flag up as an enabled plugin',
  version: 'exit 0: prints the version only',
  'cloud launch -h': 'exit 2: treats -h as the task and resolves the git origin to launch a cloud session',
  'devin launch -h': 'exit 2: treats -h as the task and resolves the git origin to launch a Devin session',
  'automations templates -h': 'exit 0: lists templates',
  'automations enable -h': 'exit 1: looks -h up as an automation (creates the automations dir)',
  'automations disable -h': 'exit 1: looks -h up as an automation (creates the automations dir)',
  'automations remove -h': 'exit 1: looks -h up as an automation (creates the automations dir)',
  'automations fire -h': 'exit 1: looks -h up as an automation',
  'jev test': 'exit 0: classifies the flag as an operator message',
  'wiki build --help': 'exit 2: "Not inside an enrolled repo", no usage',
  'wiki build -h': 'exit 2: treats -h as a repo, no usage',
  'wiki status --help': 'exit 0: prints wiki freshness ("No enrolled repos.")',
  'wiki status -h': 'exit 2: treats -h as a repo, no usage',
  'wiki show --help': 'exit 2: "Not inside an enrolled repo", no usage',
  'wiki show -h': 'exit 2: treats -h as a repo, no usage',
  'wiki ask -h': 'exit 1: asks the wiki the question "-h"',
  'playbook list -h': 'exit 0: lists playbooks',
};

/** Subset of KNOWN_HELP_ACTS whose `--help` still writes, spawns or connects. Value: the effect. */
const KNOWN_HELP_SIDE_EFFECTS: Record<string, string> = {
  index: 'writes ~/.ashlr/index.json',
  go: 'writes ~/.ashlr/index.json',
  status: 'writes ~/.ashlr/index.json',
  ls: 'writes ~/.ashlr/index.json',
  open: 'writes ~/.ashlr/index.json',
  doctor: 'spawns which/git/curl probes',
  init: 'writes ~/.local/bin/ashlr and ~/.ashlr/genome/, spawns probes',
  'mcp list': 'spawns `which` for every ecosystem binary',
  'models list': 'connects to local model servers, spawns `which ollama`',
  'models start': 'spawns `which ollama`',
  'website pause': 'writes ~/.ashlr/authority/website-publication.json',
  'website off': 'writes ~/.ashlr/authority/website-publication.json',
  'stack status': 'spawns `which stack`',
  'stack list': 'spawns `which stack`',
  'stack providers': 'spawns `which stack`',
  'stack recommend': 'spawns `which stack`',
  'stack scan': 'spawns `which stack`',
  'stack doctor': 'spawns `which stack`',
  'stack add -h': 'spawns `which stack`',
  'stack apply': 'spawns `which stack`',
  'cloud launch -h': 'runs `git remote get-url origin`',
  'devin launch -h': 'runs `git remote get-url origin`',
  'automations enable -h': 'creates ~/.ashlr/automations/',
  'automations disable -h': 'creates ~/.ashlr/automations/',
  'automations remove -h': 'creates ~/.ashlr/automations/',
};

/**
 * Deeper verbs the registry cannot enumerate (completion stops at the first
 * verb). Pinned because they were real incidents, not to replace enumeration.
 */
const PINNED_NESTED: string[][] = [['gh', 'pr', 'create']];

// ---------------------------------------------------------------------------
// CLI entry: fresh dist/ when available, otherwise the source through tsx
// ---------------------------------------------------------------------------

function distIsFresh(): boolean {
  if (!existsSync(join(ROOT, 'dist', 'cli', 'index.js'))) return false;
  const srcRoot = join(ROOT, 'src');
  const skip = new Set([join(srcRoot, 'raycast'), join(srcRoot, 'web-ui')]); // excluded by tsconfig.json
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(full) && !walk(full)) return false;
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const built = join(ROOT, 'dist', relative(srcRoot, full)).replace(/\.ts$/, '.js');
        if (!existsSync(built) || statSync(built).mtimeMs < statSync(full).mtimeMs) return false;
      }
    }
    return true;
  };
  return walk(srcRoot);
}

const USE_DIST = !IS_WINDOWS && distIsFresh();
const ENTRY_ARGS: string[] = USE_DIST
  ? [join(ROOT, 'dist', 'cli', 'index.js')]
  : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, join(ROOT, 'src', 'cli', 'index.ts')];

// ---------------------------------------------------------------------------
// Enumeration from the CLI's own completion registry
// ---------------------------------------------------------------------------

interface HelpCase { key: string; base: string; argv: string[]; cmd: string }

function enumerate(): { cases: HelpCase[]; verbs: Map<string, string[]> } {
  const home = mkdtempSync(join(tmpdir(), 'phm-help-enum-'));
  try {
    const result = spawnSync(process.execPath, [...ENTRY_ARGS, 'completions', 'bash'], {
      cwd: home, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
    });
    if (result.status !== 0) throw new Error(`completions bash failed (${String(result.status)}): ${result.stderr}`);
    const script = result.stdout;
    const top = /if \[ "\$COMP_CWORD" -eq 1 \]; then\s*COMPREPLY=\( \$\(compgen -W "([^"]+)"/.exec(script)?.[1]?.split(' ') ?? [];
    const isVerb = (word: string): boolean => word.length > 0 && !word.startsWith('-') && word !== 'help';
    const verbs = new Map<string, string[]>();
    for (const m of script.matchAll(/^\s+([\w-]+)\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/gm)) {
      verbs.set(m[1]!, (m[2] ?? '').split(' ').filter(isVerb));
    }
    const third = new Map<string, string[]>();
    for (const m of script.matchAll(/"\$\{COMP_WORDS\[1\]\}" = "([\w-]+)" \] && \[ "\$\{COMP_WORDS\[2\]\}" = "([\w-]+)" \]; then\s*COMPREPLY=\( \$\(compgen -W "([^"]+)"/g)) {
      third.set(`${m[1]!} ${m[2]!}`, (m[3] ?? '').split(' ').filter(isVerb));
    }
    const bases: string[][] = [];
    for (const cmd of top) {
      bases.push([cmd]);
      for (const verb of verbs.get(cmd) ?? []) {
        bases.push([cmd, verb]);
        for (const sub of third.get(`${cmd} ${verb}`) ?? []) bases.push([cmd, verb, sub]);
      }
    }
    bases.push(...PINNED_NESTED);
    const cases = bases.flatMap((base) => FLAGS.map((flag) => ({
      key: [...base, flag].join(' '), base: base.join(' '), argv: [...base, flag], cmd: base[0]!,
    })));
    return { cases, verbs };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const { cases: CASES, verbs: VERBS } = IS_WINDOWS ? { cases: [] as HelpCase[], verbs: new Map<string, string[]>() } : enumerate();

// ---------------------------------------------------------------------------
// Sandbox, preload guard and shims
// ---------------------------------------------------------------------------

const GUARD_SOURCE = `
import net from 'node:net';
import cp from 'node:child_process';
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.PHM_HELP_GUARD_LOG;
const shims = process.env.PHM_HELP_GUARD_SHIMS;
const stub = process.env.PHM_HELP_GUARD_STUB;
const closedPort = Number(process.env.PHM_HELP_GUARD_CLOSED_PORT);
const record = (kind, detail) => { try { fs.appendFileSync(log, JSON.stringify({ kind, detail }) + '\\n'); } catch {} };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (opts.path !== undefined && opts.port === undefined) {
    // tsx (the source-entry fallback) talks to its own loader over this pipe.
    if (!/[\\\\/]tsx-[^\\\\/]+[\\\\/]\\d+\\.pipe$/.test(String(opts.path))) record('ipc', String(opts.path));
    return connect.apply(this, args);
  }
  record('net', String(opts.host ?? 'localhost') + ':' + String(opts.port));
  const callback = args.find((value) => typeof value === 'function');
  return callback ? connect.call(this, closedPort, '127.0.0.1', callback) : connect.call(this, closedPort, '127.0.0.1');
};
const target = (file) => { const name = basename(String(file)); return name === 'gh' || name === 'git' || name === 'curl' ? shims + '/' + name : stub; };
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function (file, ...rest) {
    record('spawn', [String(file), ...(Array.isArray(rest[0]) ? rest[0].map(String) : [])].join(' '));
    return original.call(this, target(file), ...rest);
  };
}
for (const name of ['exec', 'execSync']) {
  const original = cp[name];
  cp[name] = function (command, ...rest) { record('spawn', String(command)); return original.call(this, JSON.stringify(stub), ...rest); };
}
const fork = cp.fork;
cp.fork = function (modulePath, ...rest) { record('spawn', 'fork ' + String(modulePath)); return fork.call(this, stub + '.mjs', ...rest); };
syncBuiltinESMExports();
`;

interface Observation {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  effects: string[];
}

let BASE = '';
let GUARD = '';
let STUB = '';
let TEMPLATE = '';
let CLOSED_PORT = 0;
const RESULTS = new Map<string, Observation>();

async function closedLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** path -> type and content digest, for a byte-identical before/after comparison. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) { out.set(rel, 'dir'); walk(full); }
      else if (entry.isSymbolicLink()) out.set(rel, `link:${readlinkSync(full)}`);
      else if (entry.isFile()) out.set(rel, `file:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      else out.set(rel, 'other');
    }
  };
  walk(root);
  return out;
}

function diffSnapshots(label: string, before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, value] of after) {
    if (!before.has(path)) changes.push(`created ${label}/${path}`);
    else if (before.get(path) !== value) changes.push(`changed ${label}/${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`deleted ${label}/${path}`);
  return changes;
}

const readOr = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

async function runCase(helpCase: HelpCase, index: number): Promise<Observation> {
  const box = join(BASE, `case-${index}`);
  cpSync(TEMPLATE, box, { recursive: true });
  const home = join(box, 'home');
  const work = join(box, 'work');
  const shims = join(box, 'shims');
  mkdirSync(shims);
  for (const name of ['gh', 'git', 'curl']) {
    writeFileSync(join(shims, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$PHM_HELP_GUARD_SHIM_LOG"\nexit 97\n`);
    chmodSync(join(shims, name), 0o755);
  }
  const before = { home: snapshot(home), work: snapshot(work) };
  const proxy = `http://127.0.0.1:${CLOSED_PORT}`;
  const env: NodeJS.ProcessEnv = {
    PATH: `${shims}:${process.env['PATH'] ?? ''}`,
    HOME: home,
    ASHLR_HOME: join(home, '.ashlr'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy,
    https_proxy: proxy, http_proxy: proxy, all_proxy: proxy,
    NODE_USE_ENV_PROXY: '1',
    PHM_HELP_GUARD_LOG: join(box, 'guard.log'),
    PHM_HELP_GUARD_SHIM_LOG: join(box, 'shim.log'),
    PHM_HELP_GUARD_SHIMS: shims,
    PHM_HELP_GUARD_STUB: STUB,
    PHM_HELP_GUARD_CLOSED_PORT: String(CLOSED_PORT),
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
  };
  const run = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, ...ENTRY_ARGS, ...helpCase.argv], {
      cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  const effects = [
    ...diffSnapshots('home', before.home, snapshot(home)),
    ...diffSnapshots('cwd', before.work, snapshot(work)),
    ...readOr(join(box, 'guard.log')).split('\n').filter(Boolean).map((line) => {
      const { kind, detail } = JSON.parse(line) as { kind: string; detail: string };
      return `${kind} ${detail}`;
    }),
    ...readOr(join(box, 'shim.log')).split('\n').filter(Boolean).map((line) => `shim ${line}`),
  ];
  rmSync(box, { recursive: true, force: true });
  return { ...run, effects };
}

// ---------------------------------------------------------------------------
// Usage detection
// ---------------------------------------------------------------------------

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

function cleanOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex
    .replace(/\(node:\d+\) \[UNDICI-EHPA\][^\n]*\n[^\n]*--trace-warnings[^\n]*\n/g, '');
}

/** True when the output reads as usage for `cmd`, not as the command's normal output. */
function showsUsage(cmd: string, raw: string): boolean {
  const text = cleanOutput(raw);
  if (/\busage\s*:/i.test(text)) return true;
  if (/^\s*(?:sub)?commands\s*:/im.test(text)) return true;
  const name = escapeRe(cmd);
  // A synopsis line: `phm <cmd> ...` with option or placeholder syntax.
  if (new RegExp(`^\\s*(?:ashlr|phm)\\s+${name}\\b[^\\n]*(?:\\[|<|\\s--?[a-z]|\\|)`, 'm').test(text)) return true;
  // Several `phm <cmd> <verb>` forms, or an indented listing of the command's verbs.
  if ((text.match(new RegExp(`^\\s*(?:ashlr|phm)\\s+${name}\\s+[a-z]`, 'gm')) ?? []).length >= 2) return true;
  const verbs = VERBS.get(cmd) ?? [];
  const listed = text.split('\n').filter((line) => verbs.some((verb) => new RegExp(`^\\s+${escapeRe(verb)}(?:\\s|$)`).test(line)));
  return listed.length >= 2;
}

const listed = (list: Record<string, string>, helpCase: HelpCase): boolean =>
  Object.hasOwn(list, helpCase.key) || Object.hasOwn(list, helpCase.base);

function verdict(helpCase: HelpCase, observation: Observation): { usage: boolean; meets: boolean; strict: boolean } {
  const usage = showsUsage(helpCase.cmd, observation.output);
  const clean = observation.effects.length === 0;
  return { usage, meets: observation.code === 0 && usage && clean, strict: observation.code === 2 && usage && clean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(IS_WINDOWS)('`<cmd> [verb] --help` and `-h` print usage and have no side effects', () => {
  beforeAll(async () => {
    BASE = mkdtempSync(join(tmpdir(), 'phm-help-guard-'));
    CLOSED_PORT = await closedLocalPort();
    GUARD = join(BASE, 'guard.mjs');
    writeFileSync(GUARD, GUARD_SOURCE);
    STUB = join(BASE, 'inert-child');
    writeFileSync(STUB, '#!/bin/sh\nexit 97\n');
    chmodSync(STUB, 0o755);
    writeFileSync(`${STUB}.mjs`, 'process.exit(97);\n');

    // Template sandbox: an initialized home (default config bootstrapped by the
    // CLI itself) and a git checkout with a GitHub origin as the cwd.
    TEMPLATE = join(BASE, 'template');
    const home = join(TEMPLATE, 'home');
    const work = join(TEMPLATE, 'work');
    mkdirSync(home, { recursive: true });
    mkdirSync(work);
    const bootstrap = spawnSync(process.execPath, [...ENTRY_ARGS, 'config', 'path'], {
      cwd: work, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
    });
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(existsSync(join(home, '.ashlr', 'config.json'))).toBe(true);
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', work, '-c', 'user.name=help-guard', '-c', 'user.email=help-guard@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
        stdio: 'ignore', env: { PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      });
    };
    git('init', '-q');
    writeFileSync(join(work, 'README.md'), 'help guard fixture\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');

    const concurrency = Math.max(2, Math.min(8, availableParallelism()));
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < CASES.length) {
        const index = next++;
        const helpCase = CASES[index]!;
        RESULTS.set(helpCase.key, await runCase(helpCase, index));
      }
    }));
  }, USE_DIST ? 300_000 : 900_000);

  afterAll(() => {
    if (BASE) rmSync(BASE, { recursive: true, force: true });
  });

  it('enumerates commands and verbs from the CLI registry', () => {
    const bases = new Set(CASES.map((helpCase) => helpCase.base));
    for (const expected of ['fleet', 'fleet pause', 'gh', 'gh pr', 'worker setup', 'swarm approve', 'fleet automerge-canary halt']) {
      expect(bases.has(expected), expected).toBe(true);
    }
    expect(CASES.length).toBeGreaterThan(600);
  });

  it('every allow-list and known-acts entry names an enumerated case, and the lists are consistent', () => {
    const keys = new Set(CASES.flatMap((helpCase) => [helpCase.key, helpCase.base]));
    for (const list of [HELP_STRICT_REFUSALS, KNOWN_HELP_ACTS, KNOWN_HELP_SIDE_EFFECTS]) {
      for (const entry of Object.keys(list)) expect(keys.has(entry), `stale entry: ${entry}`).toBe(true);
    }
    for (const helpCase of CASES) {
      expect(listed(HELP_STRICT_REFUSALS, helpCase) && listed(KNOWN_HELP_ACTS, helpCase), `${helpCase.key} is in two lists`).toBe(false);
      if (listed(KNOWN_HELP_SIDE_EFFECTS, helpCase)) {
        expect(listed(KNOWN_HELP_ACTS, helpCase), `${helpCase.key}: side-effect entries must also be in KNOWN_HELP_ACTS`).toBe(true);
      }
    }
  });

  it.each(CASES.map((helpCase) => [helpCase.key, helpCase] as const))('%s', (_key, helpCase) => {
    const observation = RESULTS.get(helpCase.key);
    expect(observation, 'case did not run').toBeDefined();
    if (!observation) return;
    const { usage, meets, strict } = verdict(helpCase, observation);
    const detail = `exit=${String(observation.code)} signal=${String(observation.signal)} usage=${String(usage)}\n` +
      `effects:\n  ${observation.effects.join('\n  ') || '(none)'}\noutput:\n${cleanOutput(observation.output).slice(0, 1500)}`;

    if (listed(KNOWN_HELP_ACTS, helpCase)) {
      expect(meets || strict, `${helpCase.key} now honors --help: delete it from KNOWN_HELP_ACTS (and KNOWN_HELP_SIDE_EFFECTS).\n${detail}`).toBe(false);
      if (listed(KNOWN_HELP_SIDE_EFFECTS, helpCase)) {
        expect(observation.effects.length, `${helpCase.key} no longer has side effects: delete it from KNOWN_HELP_SIDE_EFFECTS.\n${detail}`).toBeGreaterThan(0);
      } else {
        expect(observation.effects, `${helpCase.key} acted with side effects.\n${detail}`).toEqual([]);
      }
      return;
    }

    expect(observation.effects, `${helpCase.key} must not touch HOME, the cwd, the network or any subprocess.\n${detail}`).toEqual([]);
    expect(usage, `${helpCase.key} must print usage.\n${detail}`).toBe(true);
    if (listed(HELP_STRICT_REFUSALS, helpCase)) {
      expect(observation.code, `${helpCase.key} is an allow-listed strict refusal (exit 2 with usage).\n${detail}`).toBe(2);
    } else {
      expect(observation.code, `${helpCase.key} must exit 0.\n${detail}`).toBe(0);
    }
  });
});
