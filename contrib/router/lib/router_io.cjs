'use strict';

const process = globalThis.process;
const Buffer = globalThis.Buffer;
const setTimeout = globalThis.setTimeout;
const clearTimeout = globalThis.clearTimeout;
const crypto = process.getBuiltinModule('crypto');
const fs = process.getBuiltinModule('fs');
const path = process.getBuiltinModule('path');
const { spawn, spawnSync } = process.getBuiltinModule('child_process');

const FORBIDDEN = new Set([
  '--yolo',
  '--always-approve',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-hook-trust',
  'bypassPermissions',
  'danger-full-access',
]);

function die(message) {
  process.stderr.write(String(message) + '\n');
  process.exit(1);
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      out._ = out._.concat(argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) die(`missing value for --${key}`);
      out[key] = next;
      i += 1;
    } else {
      out._.push(token);
    }
  }
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function emptyState() {
  return {
    cooldowns: {},
    versions: {},
    models: {},
    freshness: { last_check: '' },
    rotation: 0,
    timeouts: {},
    pools: [],
    pools_fingerprint: '',
  };
}

function forbid(args) {
  for (const arg of args) {
    if (FORBIDDEN.has(arg)) die(`refusing forbidden flag ${arg}`);
    if (/dangerously-bypass|dangerously-skip|bypassPermissions|--yolo|always-approve/i.test(arg)) {
      die(`refusing forbidden flag ${arg}`);
    }
    if (arg === 'pull') die('refusing pull');
    if (arg === 'logout') die('refusing logout');
  }
}

function substitute(cfg, cli, tokens, model, worktree, last, prompt) {
  const row = (cfg.cli && cfg.cli[cli]) || {};
  const flag = row.model_flag || '--model';
  const args = [row.bin || cli];
  for (const token of tokens) {
    if (token === '{model}') {
      if (model && model !== '-') args.push(flag, model);
      continue;
    }
    if (token === '{model_value}') {
      if (!model || model === '-') die(`${cli} requires a model`);
      args.push(model);
      continue;
    }
    args.push(String(token)
      .split('{worktree}').join(worktree)
      .split('{last_message}').join(last)
      .split('{prompt_file}').join(prompt));
  }
  forbid(args);
  return args;
}

function emitConfig(cfg) {
  const lines = [];
  const set = (key, value) => lines.push(`${key}=${shQuote(value == null ? '' : value)}`);
  set('ROUTER_ORG', cfg.org || 'ashlrai');
  set('ROUTER_REPOS', (cfg.repos || []).join(','));
  set('ROUTER_MAX_JOBS', cfg.max_jobs == null ? 2 : cfg.max_jobs);
  set('ROUTER_MAX_PER_CLI', cfg.max_per_cli == null ? 1 : cfg.max_per_cli);
  set('ROUTER_MIN_FREE_GB', cfg.min_free_gb == null ? 20 : cfg.min_free_gb);
  set('ROUTER_MIN_BATT', cfg.min_battery_pct == null ? 30 : cfg.min_battery_pct);
  set('ROUTER_TIMEOUT_S', cfg.job_timeout_s == null ? 2700 : cfg.job_timeout_s);
  set('ROUTER_VERIFY_TIMEOUT_S', cfg.verify_timeout_s == null ? 600 : cfg.verify_timeout_s);
  set('ROUTER_FRESHNESS_ENABLED', cfg.freshness && cfg.freshness.enabled === true ? '1' : '0');
  set('ROUTER_FRESHNESS_DAYS', (cfg.freshness && cfg.freshness.interval_days) || 7);
  set('ROUTER_FRESHNESS_MIN_AGE_DAYS', (cfg.freshness && cfg.freshness.min_age_days) || 3);
  set('ROUTER_HOST_VERIFY', cfg.verify && cfg.verify.host === true ? '1' : '0');
  set('ROUTER_LEDGER_MIRROR', cfg.ledger_mirror === true ? '1' : '0');
  set('ROUTER_CODEX_PROBE', cfg.freshness && cfg.freshness.codex_probe === false ? '0' : '1');
  set('ROUTER_GROK_ENABLED', cfg.grok && cfg.grok.enabled ? '1' : '0');
  set('ROUTER_GROK_METERED', cfg.grok && cfg.grok.metered === false ? '0' : '1');
  set('ROUTER_DEVIN_ORG', (cfg.devin && cfg.devin.org_id) || '');
  set('ROUTER_LOCAL_ENABLED', cfg.local && cfg.local.enabled ? '1' : '0');
  set('ROUTER_LOCAL_BACKEND', (cfg.local && cfg.local.backend) || 'omlx');
  set('ROUTER_LOCAL_HOST', (cfg.local && cfg.local.host) || '127.0.0.1:8000');
  set('ROUTER_LOCAL_MODELS', ((cfg.local && cfg.local.models) || []).join(','));
  set('ROUTER_LOCAL_ALLOW_PULL', '0');
  set('ROUTER_LEDGER_REPO', cfg.ledger_issue_repo || 'ashlrai/phantom');
  set('ROUTER_LEDGER_TITLE', cfg.ledger_issue_title || 'router-ledger');
  set('ROUTER_PHANTOM_ROUTE', cfg.phantom_route === false ? '0' : '1');
  const tiers = cfg.tiers || {};
  for (const tier of ['frontier', 'workhorse', 'cheap']) {
    const row = tiers[tier] || {};
    for (const cli of ['codex', 'claude', 'grok', 'omlx']) {
      set(`ROUTER_TIER_${tier.toUpperCase()}_${cli.toUpperCase()}`, row[cli] || '');
    }
  }
  const cli = cfg.cli || {};
  for (const name of ['codex', 'claude', 'grok', 'omlx']) {
    const row = cli[name] || {};
    set(`ROUTER_BIN_${name.toUpperCase()}`, row.bin || name);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function writeNul(args) {
  const chunks = [];
  for (const arg of args) chunks.push(Buffer.from(String(arg), 'utf8'), Buffer.from([0]));
  process.stdout.write(Buffer.concat(chunks));
}

function configuredModels(cfg, cli) {
  const out = [];
  const tiers = cfg.tiers || {};
  for (const tier of ['frontier', 'workhorse', 'cheap']) {
    const value = tiers[tier] && tiers[tier][cli];
    if (value && out.indexOf(value) === -1) out.push(value);
  }
  return out;
}

function parseUsage(text, nowMs) {
  const limited = /rate[- ]limit|usage[- ]limit|quota exceeded|out of quota|insufficient quota|quota reached|too many requests|hit your limit|\b429\b|credits[_ ]depleted|spend control reached|usage limit reached/i.test(text);
  let reset = '';
  const iso = String(text).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (limited && iso) reset = iso[0].replace(/\.\d+Z$/, 'Z');
  if (limited && !reset) {
    const rel = String(text).match(/(?:try again|resets?|reset)[^\n]{0,40}?(\d+)\s*(seconds?|minutes?|hours?|mins?|hrs?|h|m|s)\b/i);
    let delta = 3600 * 1000;
    if (rel) {
      const count = Number(rel[1]);
      const unit = rel[2].toLowerCase();
      if (unit.startsWith('h')) delta = count * 3600 * 1000;
      else if (unit.startsWith('m')) delta = count * 60 * 1000;
      else delta = count * 1000;
    }
    reset = new Date(nowMs + delta).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  let remaining = '';
  const rem = String(text).match(/(\d+)\s*(?:%|requests?|tokens?)?\s*remaining/i)
    || String(text).match(/remaining[^0-9]{0,8}(\d+)/i);
  if (rem) remaining = rem[1];
  return {
    limited,
    reset,
    remaining,
    outcome: limited ? 'limited' : 'ok',
  };
}

function headroom(ledgerText, nowIso, cooldownJson, cliCsv) {
  const now = Date.parse(nowIso);
  const windowMs = 6 * 3600 * 1000;
  const cooldowns = JSON.parse(cooldownJson || '{}');
  const counts = {};
  const remaining = {};
  for (const line of String(ledgerText).split(/\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.event && row.event !== 'job') continue;
    const ts = Date.parse(row.ts || '');
    if (!Number.isFinite(ts) || now - ts > windowMs || ts > now + 60000) continue;
    if (!row.cli) continue;
    counts[row.cli] = (counts[row.cli] || 0) + 1;
    if (row.remaining !== undefined && row.remaining !== '' && Number.isFinite(Number(row.remaining))) {
      remaining[row.cli] = Number(row.remaining);
    }
  }
  const lines = [];
  for (const cli of String(cliCsv).split(',').filter(Boolean)) {
    let score = 1000 - 10 * (counts[cli] || 0);
    if (Object.prototype.hasOwnProperty.call(remaining, cli)) score = remaining[cli];
    const cool = cooldowns[cli];
    if (cool && cool.until && Date.parse(cool.until) > now) score = -1;
    lines.push(`${cli}\t${score}`);
  }
  return lines.join('\n');
}

function rejectsModel(text) {
  return /not available|not supported|do not have access|does not have access|don't have access|unknown model|model_not_found|invalid model|is not a valid model|rejected|cannot use model|not entitled/i.test(text);
}

function codexModels(data) {
  const rows = Array.isArray(data) ? data : (data.models || data.data || []);
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (row && (row.slug || row.id || row.model || row.name));
    if (typeof id === 'string' && id && out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

function ollamaNames(text) {
  const names = [];
  for (const line of String(text).split(/\n/)) {
    if (!line.trim() || /^NAME\s/i.test(line)) continue;
    const name = line.trim().split(/\s+/)[0];
    if (name && name !== 'NAME') names.push(name);
  }
  return names;
}

function extractDiff(text) {
  const fence = String(text).match(/```(?:diff)?\n([\s\S]*?)```/);
  const body = fence ? fence[1] : String(text);
  const idx = body.search(/^diff --git /m);
  if (idx < 0) return '';
  return body.slice(idx).replace(/\s*$/, '') + '\n';
}

function issuesToLines(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : [];
  const lines = [];
  for (const issue of rows) {
    const labels = (issue.labels || []).map((label) => (
      typeof label === 'string' ? label : label.name
    )).filter(Boolean);
    const title = Buffer.from(String(issue.title || ''), 'utf8').toString('base64');
    const body = Buffer.from(String(issue.body || ''), 'utf8').toString('base64');
    lines.push([issue.number, labels.join(','), title, body].join('\t'));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function validateRoute(text) {
  const data = JSON.parse(text);
  let cli = data.cli === 'ollama' ? 'omlx' : data.cli;
  const allowed = ['codex', 'claude', 'grok', 'omlx', 'devin'];
  if (allowed.indexOf(cli) === -1) return '';
  const model = data.model || '';
  const tier = data.tier || '';
  if (tier && ['frontier', 'workhorse', 'cheap'].indexOf(tier) === -1) return '';
  if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) return '';
  return `${cli}\t${model}\t${tier}`;
}

function mergeObjects(base, patch) {
  const next = Object.assign({}, base);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      next[key] = Object.assign({}, base[key]);
      for (const sub of Object.keys(value)) {
        const child = value[sub];
        if (child && typeof child === 'object' && !Array.isArray(child)
          && next[key][sub] && typeof next[key][sub] === 'object' && !Array.isArray(next[key][sub])) {
          next[key][sub] = Object.assign({}, next[key][sub], child);
        } else {
          next[key][sub] = child;
        }
      }
    } else {
      next[key] = value;
    }
  }
  return next;
}

function readState(file) {
  if (!fs.existsSync(file)) return emptyState();
  try {
    return mergeObjects(emptyState(), JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return emptyState();
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function lookup(state, dotted) {
  const parts = String(dotted).split('.');
  let cur = state;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function semverParts(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverLt(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

function versionOf(text) {
  const match = String(text).match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function claudeAvailable(text, code) {
  if (Number(code) !== 0) return false;
  try {
    const data = JSON.parse(text);
    if (data.authMethod === 'none' || data.loggedIn === false) return false;
    return true;
  } catch {
    return !/not logged|please login|please log in|login expired|sign in/i.test(text);
  }
}

function defaultBranch(text) {
  const data = JSON.parse(text);
  const name = data.defaultBranchRef && data.defaultBranchRef.name;
  return name || 'master';
}

function exactTitle(text, title) {
  const rows = JSON.parse(text || '[]');
  if (!Array.isArray(rows)) return '';
  for (const row of rows) {
    if (row.title === title) return String(row.number);
  }
  return '';
}

function issueNumberFromText(text) {
  const match = String(text).match(/\/issues\/(\d+)/);
  return match ? match[1] : '';
}

function openPrUrl(text) {
  const rows = JSON.parse(text || '[]');
  if (!Array.isArray(rows)) return '';
  for (const row of rows) {
    if (row.state && String(row.state).toUpperCase() !== 'OPEN') continue;
    if (row.url) return row.url;
  }
  return '';
}

function csvFrom(value) {
  if (Array.isArray(value)) return value.join(',');
  if (value == null) return '';
  return String(value);
}

function loopbackOk(host) {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

function gbFromKb(kb) {
  const value = Number(kb);
  if (!Number.isFinite(value)) return '0';
  return (value / (1024 * 1024)).toFixed(1);
}

function ledgerOutcome(flags) {
  const named = flags.outcome || '';
  if (named === 'ok' || named === 'limited' || named === 'error' || named === 'timeout') return named;
  if (flags['rate-limit']) return 'limited';
  if (Number(flags.exit) === 124) return 'timeout';
  if (Number(flags.exit || 0) !== 0) return 'error';
  return 'ok';
}

function appendJob(file, flags) {
  const remaining = flags.remaining === undefined || flags.remaining === '' ? '' : Number(flags.remaining);
  const obj = {
    ts: flags.ts || '',
    event: flags.event || 'job',
    repo: flags.repo || '',
    issue: Number(flags.issue || 0),
    cli: flags.cli || '',
    model: flags.model || '',
    model_requested: flags['model-requested'] || '',
    tier: flags.tier || '',
    attempt: Number(flags.attempt || 1),
    duration_s: Number(flags['duration-s'] || flags.duration_s || 0),
    exit: Number(flags.exit || 0),
    verify_exit: flags['verify-exit'] === undefined || flags['verify-exit'] === ''
      ? ''
      : Number(flags['verify-exit']),
    pr_url: flags['pr-url'] || '',
    rate_limit: flags['rate-limit'] || '',
    reset: flags.reset || '',
    remaining: Number.isFinite(remaining) ? remaining : '',
    outcome: ledgerOutcome(flags),
    pool: flags.pool || flags.account || flags.cli || '',
    metered: flags.metered === '1' || flags.metered === 'true',
    version: flags.version || '',
    version_before: flags['version-before'] || '',
    version_after: flags['version-after'] || '',
    warning: String(flags.warning || '').slice(0, 200),
    account: flags.account || '',
    billing: flags.billing || '',
    pools: readPoolsFile(flags['pools-file']),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function ledgerPublic(obj) {
  const keep = [
    'ts', 'event', 'repo', 'issue', 'cli', 'account', 'pool', 'outcome',
    'remaining', 'reset', 'exit', 'tier', 'model', 'pr_url', 'billing', 'metered', 'attempt',
  ];
  const out = {};
  for (const key of keep) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

function runTimeout(seconds, cmd, pgidFile) {
  if (!cmd.length) die('run-timeout missing command');
  const proc = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    detached: true,
  });
  if (pgidFile) {
    try { fs.writeFileSync(pgidFile, String(proc.pid)); } catch { /* shell reap is best effort */ }
  }
  const killGroup = (signal) => {
    try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
  };
  const groupAlive = () => {
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exitAfterGroup = (code) => {
    killGroup('SIGKILL');
    const started = Date.now();
    const tick = () => {
      if (groupAlive() && Date.now() - started < 5000) {
        setTimeout(tick, 50);
        return;
      }
      process.exit(code);
    };
    tick();
  };
  let timed = false;
  const timer = setTimeout(() => {
    timed = true;
    killGroup('SIGTERM');
    setTimeout(() => { killGroup('SIGKILL'); }, 2000);
  }, Number(seconds) * 1000);
  proc.on('exit', (code, signal) => {
    clearTimeout(timer);
    let status = 1;
    if (timed) status = 124;
    else if (!signal && code != null) status = code;
    exitAfterGroup(status);
  });
  proc.on('error', (err) => {
    clearTimeout(timer);
    die(err.message);
  });
}

function freshnessDue(last, days) {
  if (!last) return true;
  const then = Date.parse(last);
  if (!Number.isFinite(then)) return true;
  return (Date.now() - then) >= Number(days) * 24 * 3600 * 1000;
}

function cooled(until) {
  const stamp = Date.parse(until || '');
  return Number.isFinite(stamp) && stamp > Date.now();
}

const POOL_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function codexAccountRole(row, dir) {
  const codex2 = dir.endsWith(`${path.sep}.codex-2`);
  const codex1 = !codex2 && dir.endsWith(`${path.sep}.codex`);
  let id = String(row.id || '');
  if (id === 'fragile') id = 'work';
  if (id === 'durable') id = 'personal';
  let role = row.role === 'work' || row.role === 'personal' ? row.role : '';
  if (!role && (id === 'work' || codex1)) role = 'work';
  if (!role && (id === 'personal' || codex2)) role = 'personal';
  if (!role) role = 'personal';
  if (role === 'work') id = id === 'personal' ? 'work' : (id || 'work');
  if (!id) id = role;
  let order = Number(row.order);
  if (!Number.isFinite(order)) order = role === 'work' ? 1 : 2;
  const spend = role === 'work' ? 'hard' : 'overflow';
  return { id, role, order, spend, primary: role === 'work' };
}

function codexAccounts(cfg, home) {
  const configured = cfg.codex && Array.isArray(cfg.codex.accounts) ? cfg.codex.accounts : [];
  const rows = configured.length ? configured : [
    { id: 'work', home: '~/.codex', role: 'work', order: 1, spend: 'hard' },
    { id: 'personal', home: '~/.codex-2', role: 'personal', order: 2, spend: 'overflow' },
  ];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    let dir = String(row.home || '');
    if (!dir) continue;
    if (dir === '~') dir = home;
    else if (dir.startsWith('~/')) dir = path.join(home, dir.slice(2));
    if (!path.isAbsolute(dir)) continue;
    const role = codexAccountRole(row, dir);
    if (!POOL_ID.test(role.id)) continue;
    out.push({
      id: role.id,
      home: dir,
      role: role.role,
      order: role.order,
      spend: role.spend,
      primary: role.primary,
    });
  }
  out.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
  return out;
}

function accountHeadroom(ledgerText, nowIso, cooldownJson, accountCsv) {
  const now = Date.parse(nowIso);
  const windowMs = 6 * 3600 * 1000;
  const cooldowns = JSON.parse(cooldownJson || '{}');
  const counts = {};
  const remaining = {};
  for (const line of String(ledgerText).split(/\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.event && row.event !== 'job') continue;
    if (row.cli !== 'codex' || !row.account) continue;
    const ts = Date.parse(row.ts || '');
    if (!Number.isFinite(ts) || now - ts > windowMs || ts > now + 60000) continue;
    counts[row.account] = (counts[row.account] || 0) + 1;
    if (row.remaining !== undefined && row.remaining !== '' && Number.isFinite(Number(row.remaining))) {
      remaining[row.account] = Number(row.remaining);
    }
  }
  const lines = [];
  for (const id of String(accountCsv).split(',').filter(Boolean)) {
    let score = 1000 - 10 * (counts[id] || 0);
    if (Object.prototype.hasOwnProperty.call(remaining, id)) score = remaining[id];
    const cool = cooldowns[`codex:${id}`];
    if (cool && cool.until && Date.parse(cool.until) > now) score = -1;
    lines.push(`${id}\t${score}`);
  }
  return lines.join('\n');
}

function billingName(kind, billing) {
  if (billing === 'metered') return 'metered';
  if (billing === 'acu') return 'acu';
  if (kind === 'gifted-cloud' || kind === 'purchased-usage') return 'expiring-credit';
  if (kind === 'subscription-allowance') return 'subscription';
  return '';
}

function mirrorPool(row, nowIso) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const billing = billingName(row.kind, row.billing);
  if (!billing) return null;
  const provider = String(row.provider || '');
  if (['codex', 'claude', 'grok', 'devin'].indexOf(provider) === -1) return null;
  const accountId = String(row.accountId || '');
  const poolId = String(row.poolId || '');
  if (!POOL_ID.test(accountId) || !POOL_ID.test(poolId)) return null;
  let kind = row.kind == null || row.kind === '' ? null : String(row.kind);
  let unit = row.unit || null;
  let surface = row.surface == null ? null : row.surface;
  let source = row.source && typeof row.source === 'object' ? row.source : {};
  if (billing === 'metered') {
    if (kind) return null;
    if (provider !== 'grok') return null;
    kind = null;
    unit = 'USD';
    surface = null;
    source = { kind: 'native-metadata', adapter: 'grok-usage' };
  } else if (billing === 'acu') {
    if (kind) return null;
    if (provider !== 'devin') return null;
    kind = null;
    unit = 'ACU';
    surface = null;
    source = { kind: 'native-metadata', adapter: 'devin-acu' };
  } else if (kind === 'gifted-cloud' || kind === 'purchased-usage') {
    if (provider !== 'claude' || (row.unit && row.unit !== 'USD')) return null;
    if (row.expiryKind === 'rolling-release') return null;
    unit = 'USD';
    surface = kind === 'gifted-cloud' ? 'cloud-session' : 'over-plan-usage';
    source = { kind: 'verified-manual', adapter: 'claude-account-ui' };
  } else if (kind === 'subscription-allowance') {
    const adapter = provider === 'claude' ? 'claude-usage'
      : provider === 'codex' ? 'codex-rate-limits'
        : provider === 'grok' ? 'grok-usage' : null;
    if (!adapter) return null;
    if (row.total != null && row.total !== '') return null;
    if (row.amount != null && row.amount !== '' && Number(row.amount) > 100) return null;
    unit = 'percent';
    surface = 'subscription';
    source = { kind: 'native-metadata', adapter };
  } else {
    return null;
  }
  let expiresAt = row.expiresAt == null || row.expiresAt === '' ? null : String(row.expiresAt);
  let expiryKind = row.expiryKind || (expiresAt ? 'fixed' : 'unknown');
  if (kind === 'subscription-allowance') expiryKind = expiresAt ? 'rolling-release' : 'unknown';
  if (!expiresAt) expiryKind = 'unknown';
  if (expiryKind === 'unknown') expiresAt = null;
  if (['fixed', 'rolling-release', 'unknown'].indexOf(expiryKind) === -1) return null;
  if ((kind === 'gifted-cloud' || kind === 'purchased-usage') && expiryKind === 'rolling-release') return null;
  const amount = row.amount == null || row.amount === '' ? null : String(row.amount);
  const total = row.total == null || row.total === '' ? null : String(row.total);
  const quotaRemaining = row.quotaRemaining == null || row.quotaRemaining === ''
    ? null
    : Number(row.quotaRemaining);
  return {
    v: 1,
    poolId,
    kind,
    accountId,
    provider,
    amount,
    total: kind === 'subscription-allowance' ? null : total,
    unit,
    surface,
    capturedAt: row.capturedAt || nowIso,
    expiresAt,
    expiryKind,
    source,
    billing,
    quotaRemaining: Number.isFinite(quotaRemaining) ? quotaRemaining : null,
    durability: row.durability === 'fragile' || row.durability === 'durable' ? row.durability : '',
    primary: row.primary === true,
    dead: row.dead === true,
    deadReason: row.dead === true ? String(row.deadReason || 'auth').slice(0, 80) : '',
    role: row.role === 'work' || row.role === 'personal' ? row.role : '',
    order: Number.isFinite(Number(row.order)) ? Number(row.order) : 0,
    spend: row.spend === 'hard' || row.spend === 'overflow' ? row.spend : '',
    canLaunch: row.canLaunch === true,
    subscriptionLogin: row.subscriptionLogin === true,
    mirror: true,
  };
}

function usablePool(row, nowMs) {
  if (!row || !row.billing || row.dead === true) return false;
  if (row.expiresAt) {
    const exp = Date.parse(row.expiresAt);
    if (Number.isFinite(exp) && exp <= nowMs) return false;
  }
  if (row.billing === 'expiring-credit') {
    const amount = Number(row.amount);
    return Number.isFinite(amount) && amount > 0;
  }
  if (row.billing === 'subscription') {
    if (row.provider === 'grok' && row.subscriptionLogin !== true) return false;
    if (row.amount != null && row.amount !== '' && Number(row.amount) >= 100) return false;
    if (row.quotaRemaining != null && Number(row.quotaRemaining) <= 0) return false;
    return true;
  }
  if (row.billing === 'acu') {
    if (row.canLaunch !== true) return false;
    const remaining = Number(row.quotaRemaining);
    return Number.isFinite(remaining) && remaining > 0;
  }
  return row.billing === 'metered';
}

function rankOf(row) {
  if (row.billing === 'expiring-credit') return 0;
  if (row.billing === 'subscription') return 1;
  if (row.billing === 'metered') return 2;
  return 9;
}

function sortPools(rows, nowMs) {
  return rows.filter((row) => usablePool(row, nowMs)).sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const ae = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
      const be = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
      if (ae !== be) return ae - be;
    }
    if (ra === 1) {
      const aq = a.quotaRemaining == null ? -1 : Number(a.quotaRemaining);
      const bq = b.quotaRemaining == null ? -1 : Number(b.quotaRemaining);
      if (aq !== bq) return bq - aq;
      const ae = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
      const be = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
      if (ae !== be) return ae - be;
    }
    return String(a.poolId).localeCompare(String(b.poolId));
  });
}

function budgetScore(cli, pools, headroomScore, nowMs) {
  if (headroomScore < 0) return headroomScore;
  const base = headroomScore;
  const usable = (provider, billing) => pools.some((row) => (
    row && row.provider === provider && (!billing || row.billing === billing) && usablePool(row, nowMs)
  ));
  if (cli === 'codex') return 4000000 + base;
  if (cli === 'devin') return usable('devin', 'acu') ? 3000000 + Math.min(base, 999999) : base;
  if (cli === 'grok') return usable('grok', 'subscription') ? 2000000 + base : base;
  let rank = 1;
  let soonest = Number.POSITIVE_INFINITY;
  for (const row of pools) {
    if (!row || row.provider !== cli || !usablePool(row, nowMs)) continue;
    const rowRank = rankOf(row);
    if (rowRank < rank) {
      rank = rowRank;
      soonest = row.expiresAt ? Date.parse(row.expiresAt) : Number.POSITIVE_INFINITY;
    } else if (rowRank === 0 && rank === 0) {
      const exp = row.expiresAt ? Date.parse(row.expiresAt) : Number.POSITIVE_INFINITY;
      if (exp < soonest) soonest = exp;
    }
  }
  if (rank === 0) {
    const seconds = Number.isFinite(soonest)
      ? Math.max(0, Math.floor((soonest - nowMs) / 1000))
      : 99999999;
    return 500000000 - seconds;
  }
  return 1000000 + base;
}

function budgetScores(text, pools, nowMs) {
  const havePools = pools.some((row) => row && row.billing);
  const out = [];
  for (const line of String(text).split(/\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const cli = parts[0];
    const score = Number(parts[1]);
    if (!havePools || !Number.isFinite(score) || score < 0) {
      out.push(line);
      continue;
    }
    out.push(`${cli}\t${budgetScore(cli, pools, score, nowMs)}`);
  }
  return out.join('\n');
}

function readPoolsFile(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function poolsFingerprint(pools) {
  return crypto.createHash('sha256').update(JSON.stringify(pools)).digest('hex');
}

function rememberObserved(base, prev) {
  if (!prev) return base;
  base.amount = prev.amount;
  base.total = base.kind === 'subscription-allowance' ? null : prev.total;
  base.expiresAt = prev.expiresAt;
  base.expiryKind = prev.expiryKind || base.expiryKind;
  base.capturedAt = prev.capturedAt || base.capturedAt;
  base.quotaRemaining = prev.quotaRemaining;
  base.dead = prev.dead === true;
  base.deadReason = prev.dead === true ? String(prev.deadReason || 'auth') : '';
  base.canLaunch = prev.canLaunch === true;
  base.subscriptionLogin = prev.subscriptionLogin === true;
  if (base.expiryKind === 'unknown') base.expiresAt = null;
  return base;
}

function ensurePools(state, cfg, nowIso) {
  const home = process.env.HOME || '';
  const incoming = [];
  for (const row of (cfg.pools || [])) incoming.push({ row, keepObserved: false });
  for (const account of codexAccounts(cfg, home)) {
    incoming.push({
      keepObserved: true,
      row: {
        poolId: `codex-${account.id}`,
        kind: 'subscription-allowance',
        accountId: account.id,
        provider: 'codex',
        amount: null,
        total: null,
        unit: 'percent',
        surface: 'subscription',
        expiresAt: null,
        expiryKind: 'unknown',
        billing: 'subscription',
        durability: '',
        primary: account.primary,
        role: account.role,
        order: account.order,
        spend: account.spend,
        dead: false,
        deadReason: '',
        source: { kind: 'native-metadata', adapter: 'codex-rate-limits' },
      },
    });
  }
  incoming.push({
    keepObserved: true,
    row: {
      poolId: 'devin-acu',
      kind: null,
      accountId: 'devin',
      provider: 'devin',
      billing: 'acu',
      amount: null,
      total: null,
      unit: 'ACU',
      expiresAt: null,
      expiryKind: 'unknown',
      canLaunch: false,
      quotaRemaining: null,
    },
  });
  incoming.push({
    keepObserved: true,
    row: {
      poolId: 'grok-subscription',
      kind: 'subscription-allowance',
      accountId: 'grok',
      provider: 'grok',
      billing: 'subscription',
      amount: null,
      total: null,
      unit: 'percent',
      surface: 'subscription',
      expiresAt: null,
      expiryKind: 'unknown',
      subscriptionLogin: false,
      source: { kind: 'native-metadata', adapter: 'grok-usage' },
    },
  });
  if (!cfg.grok || cfg.grok.metered !== false) {
    incoming.push({
      keepObserved: true,
      row: {
        poolId: 'grok-metered',
        kind: null,
        accountId: 'grok-api',
        provider: 'grok',
        billing: 'metered',
        expiresAt: null,
        expiryKind: 'unknown',
      },
    });
  }
  const current = new Map((state.pools || []).filter((row) => row && row.poolId).map((row) => [row.poolId, row]));
  const next = [];
  const seen = new Set();
  for (const item of incoming) {
    const mirrored = mirrorPool(item.row, nowIso);
    if (!mirrored || seen.has(mirrored.poolId)) continue;
    const prev = current.get(mirrored.poolId);
    next.push(item.keepObserved ? rememberObserved(mirrored, prev) : mirrored);
    seen.add(mirrored.poolId);
    current.delete(mirrored.poolId);
  }
  for (const prev of current.values()) {
    const mirrored = mirrorPool(prev, nowIso);
    if (mirrored && !seen.has(mirrored.poolId)) next.push(mirrored);
  }
  state.pools = next;
  return state;
}

function recordQuota(state, accountId, remaining, reset, nowIso, limited) {
  const poolId = `codex-${accountId}`;
  const pools = state.pools || [];
  for (const row of pools) {
    if (!row || row.poolId !== poolId) continue;
    row.capturedAt = nowIso;
    if (remaining !== undefined && remaining !== '' && Number.isFinite(Number(remaining))) {
      row.quotaRemaining = Number(remaining);
    } else if (limited) {
      row.quotaRemaining = 0;
    }
    if (reset) {
      row.expiresAt = reset;
      row.expiryKind = 'rolling-release';
    }
  }
  state.pools = pools;
  return state;
}

function markDead(state, accountId, reason, nowIso) {
  let found = false;
  for (const row of state.pools || []) {
    if (!row || row.provider !== 'codex' || row.accountId !== accountId) continue;
    row.dead = true;
    row.deadReason = String(reason || 'auth').slice(0, 80);
    row.capturedAt = nowIso;
    found = true;
  }
  return found;
}

function authFailed(text) {
  // A missing login stays retryable. A refresh or renewal failure marks the pool dead.
  return /failed to refresh|could not refresh|cannot refresh|can't refresh|refresh token|re-?authenticate|authentication failed|auth error|invalid_grant|session expired|login expired|token expired|credentials (?:are )?expired|unable to renew|cannot renew|can't renew/i.test(String(text));
}

function classifyCodexLogin(text, code) {
  const body = String(text);
  if (/unknown command|unexpected argument|unrecognized command|invalid choice|found argument ['"]login['"]/i.test(body)) {
    return 'unsupported';
  }
  if (/not logged|not signed in|login required|please log in|please login|no credentials/i.test(body)) return 'out';
  if (Number(code) === 0) return 'in';
  return 'out';
}

function billingForCli(pools, cli, nowMs) {
  if (cli === 'ollama' || cli === 'omlx') return 'local';
  if (cli === 'devin') return 'acu';
  let billing = cli === 'grok' ? 'metered' : 'subscription';
  let sawMetered = false;
  for (const row of pools) {
    if (!row || row.provider !== cli || !usablePool(row, nowMs)) continue;
    if (row.billing === 'expiring-credit') return 'expiring-credit';
    if (row.billing === 'acu') return 'acu';
    if (row.billing === 'subscription') billing = 'subscription';
    if (row.billing === 'metered') sawMetered = true;
  }
  if (billing === 'subscription') return 'subscription';
  if (sawMetered) return 'metered';
  return billing;
}

const GROK_PLANS = /SuperGrok(?:\s+(?:Heavy|Pro|Plus|Lite))?|SuperGrok(?:Pro|Plus|Lite)|GrokPro|XPremiumPlus|XPremium|XBasic/;

function classifyGrokAuth(text) {
  const body = String(text);
  const mentionsKey = /XAI_API_KEY/i.test(body);
  if (mentionsKey && /using|set the|alternatively|environment variable|api key/i.test(body)) return 'metered';
  if (/not signed in|not logged in|login --device-code|please log in/i.test(body) && !GROK_PLANS.test(body)) return 'out';
  if (GROK_PLANS.test(body) && !mentionsKey) return 'subscription';
  if (/logged in|signed in/i.test(body) && !mentionsKey && !/not signed in|not logged/i.test(body)) return 'subscription';
  if (mentionsKey) return 'metered';
  return 'unknown';
}

const DEVIN_ORG = /^org-[A-Za-z0-9_-]{1,120}$/;

function devinView(text, expectedOrg) {
  let data;
  try { data = JSON.parse(text); } catch { return 'skip\tbad-json'; }
  const status = data && data.status && typeof data.status === 'object' ? data.status : {};
  const budget = data && data.budget && typeof data.budget === 'object' ? data.budget : {};
  if (!DEVIN_ORG.test(String(expectedOrg || ''))) return 'skip\torg';
  if (status.orgId !== expectedOrg) return 'skip\torg';
  if (status.state !== 'ready' || status.connected !== true) return 'skip\tnot-ready';
  const gate = budget.canLaunch && typeof budget.canLaunch === 'object' ? budget.canLaunch : {};
  const remaining = Number(budget.acuRemaining);
  if (gate.ok !== true || !Number.isFinite(remaining) || remaining <= 0) return 'skip\tno-acu';
  return `ok\t${remaining}\t1`;
}

function safeHttps(value) {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) ? value : '';
}

function devinLaunchView(text) {
  let data;
  try { data = JSON.parse(text); } catch { return 'fail'; }
  if (!data || data.ok !== true || !data.task || typeof data.task !== 'object') return 'fail';
  const pr = data.task.pr && typeof data.task.pr === 'object' ? safeHttps(data.task.pr.url) : '';
  return `ok\t${pr}\t${safeHttps(data.task.sessionUrl)}`;
}

function recordGrokAuth(state, kind, nowIso) {
  const allowed = ['subscription', 'metered', 'out', 'unknown', 'missing'];
  const auth = allowed.indexOf(kind) === -1 ? 'unknown' : kind;
  for (const row of state.pools || []) {
    if (!row || row.poolId !== 'grok-subscription') continue;
    row.subscriptionLogin = auth === 'subscription';
    row.capturedAt = nowIso;
  }
  state.models = state.models || {};
  state.models.grok = Object.assign({}, state.models.grok || {}, {
    auth,
    metered: auth !== 'subscription',
    checked_at: nowIso,
  });
  return state;
}

function recordDevin(state, remaining, canLaunch, nowIso) {
  const quota = remaining === '' || remaining == null ? null : Number(remaining);
  for (const row of state.pools || []) {
    if (!row || row.poolId !== 'devin-acu') continue;
    row.canLaunch = canLaunch === true || canLaunch === '1';
    row.quotaRemaining = Number.isFinite(quota) ? quota : null;
    row.amount = Number.isFinite(quota) ? String(quota) : null;
    row.capturedAt = nowIso;
  }
  state.models = state.models || {};
  state.models.devin = Object.assign({}, state.models.devin || {}, {
    can_launch: canLaunch === true || canLaunch === '1',
    acu_remaining: Number.isFinite(quota) ? quota : null,
    checked_at: nowIso,
  });
  return state;
}

function diskAllows(freeKb, sizeBytes, floorGb) {
  const free = Number(freeKb) * 1024;
  const size = Number(sizeBytes);
  const floor = Number(floorGb) * 1024 * 1024 * 1024;
  if (!Number.isFinite(free) || !Number.isFinite(size) || size < 0 || !Number.isFinite(floor)) return false;
  return free - size >= floor;
}

function hfSizeBytes(data) {
  if (!data || typeof data !== 'object') return null;
  const direct = ['size', 'usedStorage', 'total_size', 'totalSize'];
  for (const key of direct) {
    const value = Number(data[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (data.safetensors && Number.isFinite(Number(data.safetensors.total)) && Number(data.safetensors.total) > 0) {
    return Number(data.safetensors.total);
  }
  if (Array.isArray(data.siblings)) {
    let sum = 0;
    for (const row of data.siblings) {
      const value = row && Number(row.size);
      if (Number.isFinite(value) && value > 0) sum += value;
    }
    if (sum > 0) return sum;
  }
  if (data.model && data.model !== data) return hfSizeBytes(data.model);
  return null;
}

function omlxNames(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  const out = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (row && (row.id || row.name));
    if (typeof id === 'string' && id && out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

function omlxComplete(host, model, prompt) {
  if (!loopbackOk(host)) die('refusing non-loopback omlx host');
  if (!model) die('omlx requires a model');
  const url = `http://${host}/v1/chat/completions`;
  return globalThis.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) {
      process.stderr.write(`omlx http ${res.status}\n`);
      process.exit(1);
    }
    try {
      const data = JSON.parse(text);
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content;
      process.stdout.write(content == null ? '' : String(content));
    } catch {
      process.stdout.write(text);
    }
  });
}

function leaseExpired(heartbeat, nowMs, timeoutS, pidAlive) {
  if (!pidAlive) return true;
  const hb = Date.parse(heartbeat || '');
  if (!Number.isFinite(hb)) return true;
  return (nowMs - hb) > Number(timeoutS) * 1000;
}

function isoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function compileGlob(pattern) {
  const p = pattern.toLowerCase();
  let out = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegExp(c);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

const DENY_GLOBS = [
  '.github/**',
  '**/.github/**',
  'CODEOWNERS',
  '**/CODEOWNERS',
  '.releaserc',
  '.releaserc.*',
  '**/.releaserc',
  '**/.releaserc.*',
  'release*.yml',
  'release*.yaml',
  '**/release*.yml',
  '**/release*.yaml',
  'scripts/publish*',
  'scripts/**/publish*',
  '**/publish.sh',
  '**/publish.mjs',
  '**/publish.js',
  '**/publish.cjs',
  '**/rulesets/**',
  '**/*ruleset*.yml',
  '**/*ruleset*.yaml',
  '**/*ruleset*.json',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.p12',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
].map(compileGlob);

function gitCapture(wt, args) {
  return spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
}

function unsafeRepoPath(file) {
  if (!file || typeof file !== 'string') return true;
  if (file.includes('\n') || file.includes('\r') || file.includes('\0')) return true;
  if (file.startsWith('/') || file.startsWith('\\')) return true;
  const parts = file.split('/');
  return parts.some((part) => part === '..' || part === '');
}

function codeownerPatterns(text) {
  const patterns = [];
  for (const line of String(text || '').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let pattern = trimmed.split(/\s+/)[0];
    if (!pattern || pattern.startsWith('#')) continue;
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    patterns.push(pattern);
  }
  return patterns;
}

function codeownerRegexesAt(wt, rev) {
  const regexes = [];
  for (const spec of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const shown = gitCapture(wt, ['show', `${rev}:${spec}`]);
    if (!shown || shown.status !== 0 || !shown.stdout) continue;
    for (const pattern of codeownerPatterns(shown.stdout)) {
      try {
        regexes.push(compileGlob(pattern));
      } catch {
        regexes.push(/^$/);
      }
    }
  }
  return regexes;
}

function headCodeownerRegexes(wt) {
  return codeownerRegexesAt(wt, 'HEAD');
}

function porcelainPaths(buffer) {
  const paths = [];
  const text = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
  let i = 0;
  while (i + 3 <= text.length) {
    const x = String.fromCharCode(text[i]);
    const y = String.fromCharCode(text[i + 1]);
    i += 3;
    const nul = text.indexOf(0, i);
    if (nul < 0) break;
    const first = text.slice(i, nul).toString('utf8');
    i = nul + 1;
    if (first) paths.push(first);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const nul2 = text.indexOf(0, i);
      if (nul2 < 0) break;
      const second = text.slice(i, nul2).toString('utf8');
      i = nul2 + 1;
      if (second) paths.push(second);
    }
  }
  return paths;
}

function changedPaths(wt) {
  const status = gitCapture(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status || status.status !== 0) return null;
  return porcelainPaths(Buffer.from(status.stdout || '', 'utf8'));
}

function packageDiffText(wt, file, rev) {
  const committed = gitCapture(wt, ['diff', rev, 'HEAD', '--', file]);
  const work = gitCapture(wt, ['diff', rev, '--', file]);
  let text = `${(committed && committed.stdout) || ''}\n${(work && work.stdout) || ''}`;
  const tracked = gitCapture(wt, ['ls-files', '--error-unmatch', '--', file]);
  const inRev = gitCapture(wt, ['cat-file', '-e', `${rev}:${file}`]);
  if ((!tracked || tracked.status !== 0) && (!inRev || inRev.status !== 0)) {
    const untracked = gitCapture(wt, ['diff', '--no-index', '--', '/dev/null', file]);
    text += `\n${(untracked && untracked.stdout) || ''}`;
  }
  return text;
}

function packageAltersRelease(wt, file, rev) {
  const base = file.split('/').pop();
  if (base !== 'package.json') return false;
  let text = '';
  if (rev) {
    text = packageDiffText(wt, file, rev);
  } else {
    const diff = gitCapture(wt, ['diff', 'HEAD', '--', file]);
    const cached = gitCapture(wt, ['diff', '--cached', '--', file]);
    text = `${(diff && diff.stdout) || ''}\n${(cached && cached.stdout) || ''}`;
    const tracked = gitCapture(wt, ['ls-files', '--error-unmatch', '--', file]);
    if (!tracked || tracked.status !== 0) {
      const untracked = gitCapture(wt, ['diff', '--no-index', '--', '/dev/null', file]);
      text += `\n${(untracked && untracked.stdout) || ''}`;
    }
  }
  return /(^|\n)[+-].*"(publish|prepublish|prepublishOnly|postpublish|prepare|release)"\s*:/.test(text)
    || /(^|\n)[+-].*publishConfig/.test(text);
}

function matchDenied(wt, paths, owners, rev) {
  if (paths == null) return ['<unreadable>'];
  const denied = [];
  for (const file of paths) {
    if (unsafeRepoPath(file)) {
      denied.push(file || '<unsafe>');
      continue;
    }
    const lower = file.toLowerCase();
    const globHit = DENY_GLOBS.some((re) => re.test(lower)) || owners.some((re) => re.test(lower));
    if (globHit || packageAltersRelease(wt, file, rev)) denied.push(file);
  }
  return denied;
}

function deniedPaths(wt) {
  return matchDenied(wt, changedPaths(wt), headCodeownerRegexes(wt), '');
}

function diffTreePaths(wt, rev) {
  const shown = gitCapture(wt, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', rev]);
  if (!shown || shown.status !== 0) return null;
  const paths = [];
  const buf = Buffer.from(shown.stdout || '', 'utf8');
  let i = 0;
  while (i < buf.length) {
    const nul = buf.indexOf(0, i);
    if (nul < 0) break;
    const file = buf.slice(i, nul).toString('utf8');
    i = nul + 1;
    if (file) paths.push(file);
  }
  return paths;
}

function deniedCommitPaths(wt) {
  return matchDenied(wt, diffTreePaths(wt, 'HEAD'), codeownerRegexesAt(wt, 'HEAD~1'), 'HEAD~1');
}

function statusPaths(wt, args) {
  const shown = gitCapture(wt, args);
  if (!shown || shown.status !== 0) return null;
  const buf = Buffer.from(shown.stdout || '', 'utf8');
  const paths = [];
  let i = 0;
  while (i < buf.length) {
    const sEnd = buf.indexOf(0, i);
    if (sEnd < 0) break;
    const status = buf.slice(i, sEnd).toString('utf8');
    i = sEnd + 1;
    if (!status) break;
    const p1 = buf.indexOf(0, i);
    if (p1 < 0) break;
    const first = buf.slice(i, p1).toString('utf8');
    i = p1 + 1;
    if (first) paths.push(first);
    if (status[0] === 'R' || status[0] === 'C') {
      const p2 = buf.indexOf(0, i);
      if (p2 < 0) break;
      const second = buf.slice(i, p2).toString('utf8');
      i = p2 + 1;
      if (second) paths.push(second);
    }
  }
  return paths;
}

function deniedSince(wt, base) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(base || ''))) return ['<unreadable>'];
  const committed = statusPaths(wt, ['diff', '--name-status', '-z', base, 'HEAD']);
  const work = statusPaths(wt, ['diff', '--name-status', '-z', base]);
  const dirty = changedPaths(wt);
  if (committed == null || work == null || dirty == null) return ['<unreadable>'];
  const seen = new Set();
  const paths = [];
  for (const file of committed.concat(work, dirty)) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    paths.push(file);
  }
  return matchDenied(wt, paths, codeownerRegexesAt(wt, base), base);
}

function branchAllowed(branch) {
  return /^(router\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|cursor\/router-[A-Za-z0-9._-]+)$/.test(String(branch || ''));
}

function agedRelease(timeJson, days, nowMs) {
  let data;
  try {
    data = JSON.parse(timeJson);
  } catch {
    return '';
  }
  if (!data || typeof data !== 'object') return '';
  const minAge = Number(days) * 24 * 3600 * 1000;
  let best = '';
  let bestTime = -1;
  for (const [ver, stamp] of Object.entries(data)) {
    if (ver === 'modified' || ver === 'created') continue;
    if (!/^\d+\.\d+\.\d+/.test(ver)) continue;
    const then = Date.parse(stamp);
    if (!Number.isFinite(then)) continue;
    if (nowMs - then < minAge) continue;
    if (then >= bestTime) {
      bestTime = then;
      best = ver;
    }
  }
  return best;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === 'emit-config') {
    emitConfig(loadJson(flags._[0]));
    return;
  }
  if (command === 'argv') {
    const cfg = loadJson(flags.config);
    const tokens = ((cfg.cli || {})[flags.cli] || {}).args || [];
    writeNul(substitute(cfg, flags.cli, tokens, flags.model || '', flags.worktree || '', flags.last || '', flags.prompt || ''));
    return;
  }
  if (command === 'probe-argv') {
    const cfg = loadJson(flags.config);
    const row = (cfg.cli && cfg.cli.codex) || {};
    writeNul(substitute(cfg, 'codex', row.probe_args || [], flags.model || '', '', '', ''));
    return;
  }
  if (command === 'update-argv') {
    const cfg = loadJson(flags.config);
    const row = (cfg.cli && cfg.cli[flags.cli]) || {};
    writeNul(row.update || []);
    return;
  }
  if (command === 'configured-models') {
    const cfg = loadJson(flags.config);
    process.stdout.write(configuredModels(cfg, flags.cli).join('\n') + '\n');
    return;
  }
  if (command === 'issues-to-lines') {
    process.stdout.write(issuesToLines(readStdin()));
    return;
  }
  if (command === 'parse-usage') {
    const now = flags.now ? Number(flags.now) * 1000 : Date.now();
    process.stdout.write(JSON.stringify(parseUsage(readStdin(), now)) + '\n');
    return;
  }
  if (command === 'headroom') {
    const ledger = fs.existsSync(flags._[0]) ? fs.readFileSync(flags._[0], 'utf8') : '';
    const text = headroom(ledger, flags.now, flags.cooldowns || '{}', flags.clis || '');
    process.stdout.write(text + (text ? '\n' : ''));
    return;
  }
  if (command === 'rejects-model') {
    process.exit(rejectsModel(readStdin()) ? 0 : 1);
  }
  if (command === 'codex-models') {
    process.stdout.write(codexModels(loadJson(flags._[0])).join('\n') + '\n');
    return;
  }
  if (command === 'ollama-names') {
    process.stdout.write(ollamaNames(readStdin()).join('\n') + '\n');
    return;
  }
  if (command === 'extract-diff') {
    process.stdout.write(extractDiff(readStdin()));
    return;
  }
  if (command === 'package-scripts') {
    const pkg = loadJson(flags._[0]);
    const scripts = pkg.scripts || {};
    const out = [];
    if (scripts.test) out.push('test');
    if (scripts.lint) out.push('lint');
    process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
    return;
  }
  if (command === 'validate-route') {
    const line = validateRoute(readStdin());
    if (!line) process.exit(1);
    process.stdout.write(line + '\n');
    return;
  }
  if (command === 'patch-state') {
    const file = flags._[0];
    const patch = JSON.parse(readStdin());
    writeState(file, mergeObjects(readState(file), patch));
    return;
  }
  if (command === 'get') {
    const value = lookup(readState(flags._[0]), flags._[1] || '');
    if (value == null) process.stdout.write('\n');
    else if (typeof value === 'object') process.stdout.write(JSON.stringify(value) + '\n');
    else process.stdout.write(String(value) + '\n');
    return;
  }
  if (command === 'csv') {
    const value = lookup(readState(flags._[0]), flags._[1] || '');
    process.stdout.write(csvFrom(value) + '\n');
    return;
  }
  if (command === 'cooldowns-json') {
    const state = readState(flags._[0]);
    process.stdout.write(JSON.stringify(state.cooldowns || {}) + '\n');
    return;
  }
  if (command === 'append-job') {
    appendJob(flags._[0], flags);
    return;
  }
  if (command === 'last-ledger') {
    const file = flags._[0];
    const count = Number(flags._[1] || 10);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean);
    const tail = lines.slice(-count);
    process.stdout.write(tail.join('\n') + (tail.length ? '\n' : ''));
    return;
  }
  if (command === 'semver-lt') {
    process.exit(semverLt(flags._[0], flags._[1]) ? 0 : 1);
  }
  if (command === 'version-of') {
    process.stdout.write(versionOf(readStdin()) + '\n');
    return;
  }
  if (command === 'claude-available') {
    process.exit(claudeAvailable(readStdin(), flags.code || '0') ? 0 : 1);
  }
  if (command === 'default-branch') {
    process.stdout.write(defaultBranch(readStdin()) + '\n');
    return;
  }
  if (command === 'exact-title') {
    process.stdout.write(exactTitle(readStdin(), flags.title || '') + '\n');
    return;
  }
  if (command === 'issue-number') {
    process.stdout.write(issueNumberFromText(readStdin()) + '\n');
    return;
  }
  if (command === 'open-pr') {
    process.stdout.write(openPrUrl(readStdin()) + '\n');
    return;
  }
  if (command === 'b64dec') {
    process.stdout.write(Buffer.from(flags._[0] || '', 'base64').toString('utf8'));
    return;
  }
  if (command === 'loopback-ok') {
    process.exit(loopbackOk(flags._[0] || '') ? 0 : 1);
  }
  if (command === 'gb') {
    process.stdout.write(gbFromKb(flags._[0] || '0') + '\n');
    return;
  }
  if (command === 'freshness-due') {
    process.exit(freshnessDue(flags.last || '', flags.days || '7') ? 0 : 1);
  }
  if (command === 'publish-check' || command === 'commit-check' || command === 'range-check') {
    const wt = flags.worktree || flags._[0] || '';
    let denied;
    if (command === 'commit-check') denied = deniedCommitPaths(wt);
    else if (command === 'range-check') denied = deniedSince(wt, flags.base || '');
    else denied = deniedPaths(wt);
    if (denied.length) {
      process.stdout.write(`${denied.join('\n')}\n`);
      process.exit(1);
    }
    return;
  }
  if (command === 'stage-list') {
    const paths = changedPaths(flags.worktree || flags._[0] || '');
    if (paths == null) process.exit(1);
    writeNul(paths);
    return;
  }
  if (command === 'branch-ok') {
    process.exit(branchAllowed(flags._[0] || '') ? 0 : 1);
  }
  if (command === 'aged-release') {
    const now = Number(flags.now || Date.now());
    const nowMs = now < 1e12 ? now * 1000 : now;
    const ver = agedRelease(readStdin(), flags.days || '3', nowMs);
    process.stdout.write(`${ver}\n`);
    process.exit(ver ? 0 : 1);
  }
  if (command === 'ledger-public') {
    process.stdout.write(`${JSON.stringify(ledgerPublic(JSON.parse(readStdin())))}\n`);
    return;
  }
  if (command === 'cooled') {
    process.exit(cooled(flags.until || '') ? 0 : 1);
  }
  if (command === 'run-timeout') {
    const seconds = flags._[0];
    runTimeout(seconds, flags._.slice(1), flags['pgid-file'] || '');
    return;
  }
  if (command === 'now') {
    process.stdout.write(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n');
    return;
  }
  if (command === 'replay-ledger') {
    const temp = flags._[0];
    const dest = flags._[1];
    const pr = flags['pr-url'] || '';
    if (!fs.existsSync(temp)) return;
    const lines = fs.readFileSync(temp, 'utf8').split(/\n/).filter(Boolean);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (const line of lines) {
      const obj = JSON.parse(line);
      delete obj.raw;
      delete obj.usage;
      obj.pr_url = pr;
      const stamped = JSON.stringify(obj);
      fs.appendFileSync(dest, stamped + '\n');
      process.stdout.write(stamped + '\n');
    }
    return;
  }
  if (command === 'set-cooldown') {
    const file = flags._[0];
    const state = readState(file);
    const reason = flags.reason === 'auth' ? 'auth' : 'rate-limit';
    state.cooldowns[flags.cli] = {
      until: flags.until || '',
      reason,
    };
    writeState(file, state);
    return;
  }
  if (command === 'set-timeout') {
    const file = flags._[0];
    const state = readState(file);
    state.timeouts[flags.key] = flags.until || '';
    writeState(file, state);
    return;
  }
  if (command === 'codex-accounts') {
    const cfg = loadJson(flags.config);
    const home = flags.home || process.env.HOME || '';
    const rows = codexAccounts(cfg, home);
    process.stdout.write(rows.map((row) => `${row.id}\t${row.home}`).join('\n') + (rows.length ? '\n' : ''));
    return;
  }
  if (command === 'mark-dead') {
    const nowIso = flags.now || isoFromMs(Date.now());
    const state = readState(flags.state);
    if (!markDead(state, flags.account || '', flags.reason || 'auth', nowIso)) process.exit(1);
    writeState(flags.state, state);
    return;
  }
  if (command === 'pool-dead') {
    const account = flags.account || '';
    const pools = readState(flags.state).pools || [];
    const dead = pools.some((row) => row && row.provider === 'codex' && row.accountId === account && row.dead === true);
    process.exit(dead ? 0 : 1);
  }
  if (command === 'auth-failed') {
    process.exit(authFailed(readStdin()) ? 0 : 1);
  }
  if (command === 'codex-login') {
    const kind = classifyCodexLogin(readStdin(), flags.code || '0');
    process.stdout.write(kind + '\n');
    return;
  }
  if (command === 'account-headroom') {
    const ledger = fs.existsSync(flags._[0]) ? fs.readFileSync(flags._[0], 'utf8') : '';
    const text = accountHeadroom(ledger, flags.now, flags.cooldowns || '{}', flags.accounts || '');
    process.stdout.write(text + (text ? '\n' : ''));
    return;
  }
  if (command === 'order-pools') {
    const nowMs = flags.now ? Number(flags.now) * 1000 : Date.now();
    const rows = JSON.parse(readStdin()).map((row) => mirrorPool(row, isoFromMs(nowMs))).filter(Boolean);
    const ordered = sortPools(rows, nowMs);
    process.stdout.write(ordered.map((row) => (
      [row.poolId, row.billing, row.provider, row.expiresAt || ''].join('\t')
    )).join('\n') + (ordered.length ? '\n' : ''));
    return;
  }
  if (command === 'budget-scores') {
    const nowMs = flags.now ? Number(flags.now) * 1000 : Date.now();
    const pools = flags.state && fs.existsSync(flags.state) ? (readState(flags.state).pools || []) : [];
    const text = budgetScores(readStdin(), pools, nowMs);
    process.stdout.write(text + (text ? '\n' : ''));
    return;
  }
  if (command === 'ensure-pools') {
    const nowIso = flags.now || isoFromMs(Date.now());
    const state = ensurePools(readState(flags.state), loadJson(flags.config), nowIso);
    writeState(flags.state, state);
    return;
  }
  if (command === 'pools-json') {
    const pools = readState(flags._[0]).pools || [];
    process.stdout.write(JSON.stringify(pools));
    return;
  }
  if (command === 'pools-fingerprint') {
    const pools = readState(flags._[0]).pools || [];
    process.stdout.write(poolsFingerprint(pools) + '\n');
    return;
  }
  if (command === 'record-quota') {
    const nowIso = flags.now || isoFromMs(Date.now());
    const state = recordQuota(
      readState(flags.state),
      flags.account || '',
      flags.remaining == null ? '' : flags.remaining,
      flags.reset || '',
      nowIso,
      flags.limited === '1',
    );
    writeState(flags.state, state);
    return;
  }
  if (command === 'billing-for') {
    const nowMs = flags.now ? Number(flags.now) * 1000 : Date.now();
    const pools = readState(flags.state).pools || [];
    process.stdout.write(billingForCli(pools, flags.cli || '', nowMs) + '\n');
    return;
  }
  if (command === 'lease-expired') {
    const nowMs = flags.now ? Number(flags.now) * 1000 : Date.now();
    process.exit(leaseExpired(flags.heartbeat || '', nowMs, flags.timeout || '0', flags['pid-alive'] === '1') ? 0 : 1);
  }
  if (command === 'lease-fresh') {
    const nowMs = flags.now ? Number(flags.now) * 1000 : Date.now();
    const fresh = !leaseExpired(flags.heartbeat || '', nowMs, flags.timeout || '0', true);
    process.exit(fresh ? 0 : 1);
  }
  if (command === 'write-meta') {
    const obj = {
      repo: flags.repo || '',
      issue: Number(flags.issue || 0),
      clone: flags.clone || '',
      worktree: flags.worktree || '',
      cli: flags.cli || '',
      account: flags.account || '',
    };
    fs.writeFileSync(flags.file, JSON.stringify(obj) + '\n');
    return;
  }
  if (command === 'json-get') {
    const data = loadJson(flags._[0]);
    const value = lookup(data, flags._[1] || '');
    if (value == null) process.stdout.write('\n');
    else process.stdout.write(String(value) + '\n');
    return;
  }
  if (command === 'set-fingerprint') {
    const state = readState(flags._[0]);
    state.pools_fingerprint = flags.value || '';
    writeState(flags._[0], state);
    return;
  }
  if (command === 'grok-auth') {
    process.stdout.write(classifyGrokAuth(readStdin()) + '\n');
    return;
  }
  if (command === 'devin-org') {
    process.exit(DEVIN_ORG.test(String(flags.value || flags._[0] || '')) ? 0 : 1);
  }
  if (command === 'devin-view') {
    process.stdout.write(devinView(readStdin(), flags.org || '') + '\n');
    return;
  }
  if (command === 'devin-launch') {
    process.stdout.write(devinLaunchView(readStdin()) + '\n');
    return;
  }
  if (command === 'record-grok-auth') {
    const nowIso = flags.now || isoFromMs(Date.now());
    const state = recordGrokAuth(readState(flags.state), flags.class || flags.kind || '', nowIso);
    writeState(flags.state, state);
    return;
  }
  if (command === 'record-devin') {
    const nowIso = flags.now || isoFromMs(Date.now());
    const state = recordDevin(
      readState(flags.state),
      flags.remaining == null ? '' : flags.remaining,
      flags.launch || '0',
      nowIso,
    );
    writeState(flags.state, state);
    return;
  }
  if (command === 'disk-allows') {
    process.exit(diskAllows(flags['free-kb'] || '0', flags['size-bytes'] || '0', flags['floor-gb'] || '20') ? 0 : 1);
  }
  if (command === 'model-size') {
    let data;
    try { data = JSON.parse(readStdin()); } catch { process.exit(1); }
    const size = hfSizeBytes(data);
    if (!Number.isFinite(size)) process.exit(1);
    process.stdout.write(String(size) + '\n');
    return;
  }
  if (command === 'omlx-names') {
    process.stdout.write(omlxNames(readStdin()).join('\n') + '\n');
    return;
  }
  if (command === 'omlx-complete') {
    omlxComplete(flags.host || '', flags.model || '', readStdin()).catch((err) => die(err.message));
    return;
  }
  die(`unknown command ${command || ''}`);
}

main();
