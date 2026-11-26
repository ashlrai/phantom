/**
 * cli/completions.ts — `ashlr completions zsh|bash` (M31).
 *
 * Emits a STATIC shell-completion script generated from the top-level command
 * table. Install:
 *   zsh:  ashlr completions zsh  > ~/.zsh/completions/_ashlr   (fpath dir)
 *   bash: ashlr completions bash > ~/.local/share/bash-completion/completions/ashlr
 *
 * Read-only: prints to stdout, writes nothing. Exit codes: 0 / 2 bad usage.
 */

import { makeColors, isTty } from './ui.js';

/**
 * Top-level commands (kept in sync by test/m31.cli-agent.test.ts AND, since
 * M-cli-audit, by a structural drift test — test/cli-registry-drift.test.ts —
 * that parses the real dispatch switch in src/cli/index.ts and fails if this
 * list (or HELP_ENTRIES) ever falls out of sync with it again).
 */
export const TOP_LEVEL_COMMANDS: string[] = [
  'graph',
  'index', 'go', 'status', 'ls', 'open', 'tidy', 'config', 'doctor', 'companions', 'team', 'approvals', 'decisions', 'org', 'lanes', 'steward', 'improve', 'autopilot', 'metrics', 'jobs', 'recut', 'self', 'empties', 'shipped', 'mobile', 'throughput', 'merges', 'home', 'today', 'asks', 'needs-you', 'subagent', 'init',
  'setup', 'install', 'mcp', 'run', 'runs', 'eval', 'pulse', 'pulse-export', 'pulse-test', 'land',
  'new', 'ship', 'recall', 'learn', 'genome',
  'self-swap', 'self-update', 'update', 'upgrade', 'desktop', 'desktop-update', 'desktopctl', 'apps', 'browser', 'app', 'spec', 'swarm', 'swarms', 'tui', 'dash', 'dashboard', 'serve', 'models',
  'gh', 'vercel', 'website', 'wire', 'notify', 'telemetry', 'router', 'router-calibration', 'node', 'sandbox', 'audit',
  'enroll', 'backlog', 'inbox', 'ideas', 'claim', 'daemon', 'worker', 'ask', 'knowledge', 'reflect',
  'health', 'goals', 'pr', 'prs', 'fleet', 'recovery', 'manager', 'vision', 'goal', 'loop',
  'roadmap', 'stack', 'ecosystem', 'digest', 'sweep', 'seams', 'verify', 'engineering-receipt', 'verify-safety', 'verify-pr', 'release-articles', 'release', 'releases', 'local', 'preflight',
  'conductor-permit', 'signals', 'friction',
  'onboard', 'demo', 'orient', 'docs', 'completions', 'plugins', 'x', 'comms', 'comms-agent', 'mason', 'outbox',
  'agentnet', 'amplify', 'channels', 'context', 'connectors', 'imessage', 'memory', 'route', 'radar', 'observe', 'growth', 'world', 'settings', 'drafts',
  'director', 'best-of-n', 'invent', 'ideas', 'resource', 'resources', 'repos', 'usage', 'version', 'help',
  'skills', 'universe', 'runtime', 'tune', 'tools', 'inventory', 'pools', 'messages', 'map',
  // Dispatched by index.ts but previously missing here, so completion and
  // "did you mean" were blind to them (caught by cli-registry-drift).
  'verse', 'console', 'local-runtime',
  // V3.10 Track B: standing authority, the Leader, fleet mirrors.
  'authority', 'leader', 'mirror', 'owner-live', 'owner',
  // 3.11 cloud lane.
  'cloud',
  // 3.15 Devin lane.
  'devin',
  'bots',
  'openai-agents',
  'agents',
  'benchmark', 'queue', 'issues', 'incident', 'chain', 'select', 'job', 'pool', 'admission',
  // 3.15 automations.
  'automations', 'routines',
  // 3.15 Jev decision layer.
  'jev',
  // 3.15 private repo wiki.
  'wiki',
  // 3.15 versioned playbooks.
  'playbook',
  // receipt.v1: `receipt` is the same as `fleet receipt`.
  'receipt',
  // Shared task board: `bus` is the same as `fleet bus`.
  'bus',
  // Dispatched by index.ts but missing here (caught by cli-registry-drift).
  'worktrees', 'drive', 'bets', 'plan', 'budget', 'capacity', 'top', 'sessions', 'checkpoint',
  // Stigmergic coordination markers (RQ-SWE5-STIGMERGY).
  'trail',
  // Estate cards and daily CI metrics (RQ-ESTATES, RQ-CIMETRICS).
  'estates', 'ci', 'ci-metrics', 'daily-fix', 'main',
  // Read-only disk report for agent worktrees (RQ-DISKFLOW).
  'disk', 'app', 'radar',
  // What is loading this computer, by group (RQ-HOSTLOADN18PQ8).
  'host',
  // Standing disk maintenance: plan/apply reclaim classes (RQ-DISKMAINT).
  'disk-maint',
  // Read-only view of every pooled computer (RQ-NODESN17RQ8). `autonomy` was
  // dispatched but missing here, which kept cli-registry-drift red on master.
  'nodes', 'autonomy',
  // Eng Ops incident auto-fix (RQ-SELF-AWARE-AUTOFIX-1).
  'autofix',
  // Changed-file tests and the fleet event feed.
  'test', 'check', 'feed',
  'work', 'worklog', 'log', 'library', 'decide', 'spend',
  // Dispatched by index.ts but missing here (caught by cli-registry-drift).
  'constitution', 'wb', 'caps',
  // COS report pages for the loopback dashboard (RQ-COS-PAGES-1).
  'pages',
  'publish',
  // The typed command catalog the desktop palette also lists (RQ-CMDPALN17TQ8).
  'commands',
];

/** Subcommands per top-level command (first-position completion only). */
const SUBCOMMANDS: Record<string, string[]> = {
  docs: ['cli', '--agent', '--check', '--json', '--help'],
  approvals: ['ask', 'answer', '--team', '--question', '--options', '--expires', '--by', '--json', '--help'],
  subagent: ['spawn', 'list', 'result'],
  graph: ['nodes', 'edges', 'status', '--fleet', '--seats', '--json', '--help'],
  sweep: ['report'],
  check: ['--base', '--json', '--help'],
  companions: ['--json', '--root', '--bin-dir', '--secrets-bin', '--locus-bin', '--lexicon-bin', '--help'],
  disk: ['--wt-dir', '--runs-dir', '--tmp-dir', '--json', '--help'],
  nodes: ['plan', 'doctor', 'pool', '--json', '--can-take', '--node', '--help'],
  map: ['--json', '--help'],
  'disk-maint': ['schedule', '--apply', '--inventory', '--json', '--only', '--allow', '--compress-days', '--prune-days', '--help'],
  autofix: ['--apply', '--dry-run', '--json', '--only', '--older-than', '--stuck-minutes', 'release-stuck-draft', 'launchd-crashloop', 'stuck-lane', 'outside-load', '--help'],
  desktop: ['install', 'list-apps', 'windows', 'focus', 'read', 'scroll', 'type', 'click', 'screenshot', 'doctor', '--upgrade', '--rollback', '--require-app', '--to', '--apply', '--json', '--app', '--window', '--text', '--x', '--y', '--dx', '--dy', '--ref', '--help'],
  'desktop-update': ['inspect', 'apply', '--help'],
  desktopctl: ['capabilities', 'doctor', 'status', 'run', '--task', '--timeout', '--poll', '--json', '--help'],
  app: ['update', 'status', 'steer', '--text', 'restart', '--json', '--help'],
  radar: ['list', 'run', 'diff', '--json', '--help'],
  mason: ['thread', 'digest', '--since', '--post', '--json', '--help'],
  'comms-agent': ['status', 'run', 'drafts', '--json', '--dir', '--lanes', '--help'],
  claim: ['acquire', 'release', '--lane', '--reason', '--json', '--help'],
  usage: ['sensors', 'spend', 'limits', 'live', 'resource-live', 'history', 'validate', '--lane', '--json', '--refresh', '--file', '--watch', '--force', '--show', '--browser', '--headed', '--interval', '--queue-dir', '--bus-dir', '--runs-dir', '--help'],
  observe: ['session', '--json', '--human-steps', '--bottlenecks', '--prs', '--days', '--claim-minutes', '--help'],
  budget: ['show', 'add', 'get', 'set', '--json', '--provider', '--period', '--usd', '--bucket', '--remaining', '--reset-at', '--at', '--source', '--input', '--help'],
  world: ['get', '--json', '--refresh', '--help'],
  chain: ['verify', '--json', '--help'],
  incident: ['report', 'receipts', '--json', '--help'],
  browser: ['doctor', 'open', 'tabs', 'shot', 'close', '--browser', '--json', '--help'],
  apps: ['list', 'log', 'open', 'quit', 'restart', 'focus', 'status', 'suggest', 'request', '--pressure', '--need-mb', '--limit', '--json', '--help'],
  // Mirrors the verb check in src/cli/repos-rank.ts (cmdReposRank).
  repos: ['rank', 'proposals', '--json', '--recompute', '--help'],
  'release-articles': ['status', 'metadata', 'enable', 'disable', 'import', 'sync', '--help'],
  release: ['status', 'notes', 'autonomy', '--since', '--write', '--json', '--file', '--help'],
  releases: ['--json', '--help'],
  agents: ['apps', 'bus', 'conversations', 'help', 'list', 'messages', 'roster', 'show', 'validate', 'versions'],
  // Mirror the verb switch in src/cli/wb.ts (cmdWb).
  wb: ['secrets', 'steer', 'reprioritize', 'stop', '--text', '--priority', '--apply', '--json', '--help'],
  'openai-agents': ['sessions', 'inspect', 'turns', 'help'],
  queue: ['stats', 'report', 'add', 'claim', 'done', 'block', 'replay', 'list', 'import', 'export', 'spawn', 'promote', 'serve', 'stuck', '--help'],
  land: ['auto', '--repo', '--apply', '--json', '--help'],
  job: ['cost', 'pause', 'resume', 'stop', 'move', 'say', 'notes', '--help'],
  admission: ['explain', '--json', '--help'],
  benchmark: ['run', '--compare-reports', 'help'],
  metrics: ['summary', 'dashboard', 'record', 'recommend', 'ingest', 'levers', 'leverage', 'leverage-mix', 'idle', 'impact', 'prod', 'loop', 'help'],
  plan: ['check', 'dup', 'help'],
  bets: ['check', 'propose', 'list', 'launch', 'score', 'kill', 'help'],
  config: ['get', 'set', 'path', 'effective'],
  mcp: ['list', 'doctor', 'install', 'ecosystem', 'run', 'fleet'],
  run: ['show'],
  router: ['rank', 'serve', 'models', 'pick', 'config', 'catalog', 'outcomes'],
  spec: ['new', 'list', 'show', 'refine'],
  swarm: ['show', 'verify', 'approve', 'rollback'],
  verify: ['change', 'done', '--worktree', '--checks', '--contract', '--plan', '--help'],
  models: ['list', 'check', 'radar', 'pull', 'start', 'inventory', 'routing', 'verify'],
  gh: ['pr', 'issue', 'ci'],
  vercel: ['ls', 'logs'],
  website: ['status', 'auto', 'pause', 'off', 'request', 'run', 'prepare', 'commission'],
  wire: ['claude', 'codex', 'cursor', 'gemini', 'all', 'status'],
  notify: ['test', 'session', 'route', 'rules'],
  telemetry: ['status', 'test'],
  node: ['bootstrap', 'join', 'beat', 'enqueue', 'plan', 'pull', 'renew', 'complete', 'release', 'withdraw', 'result', 'bridge', 'list', 'status', 'leave', 'pool', 'watch', 'worker', 'run-once', 'rpc', 'lanes', 'capacity', 'route', 'measure', 'self-update', 'light'],
  sandbox: ['list', 'diff', 'cleanup', 'gc'],
  enroll: ['add', 'remove', 'list', 'kill'],
  backlog: ['refresh', 'plan', 'lint'],
  inbox: ['list', 'show', 'approve', 'submit', 'reject', 'automerge'],
  daemon: [
    'start', 'stop', 'status', 'activation-preflight', 'activate',
    'recover-state', 'resolve-state', 'install', 'uninstall', 'service-status',
    'pause', 'resume', 'doctor', 'health',
  ],
  worker: ['setup', 'status'],
  prs: ['triage'],
  pr: ['resolve-conflicts', '--repo', '--pr', '--limit', '--root', '--out', '--allowlist', '--apply', '--json'],
  fleet: [
    'status', 'session', 'watch', 'events', 'lanes', 'lane-slots', 'direction', 'init', 'pause', 'resume', 'doctor',
    'automerge-canary', 'receipt', 'evidence', 'scorecard', 'oversight',
    'judge-traces', 'judge-health', 'optimize-prompt', 'xreview', 'queue', 'outcomes', 'backlog', 'lane-slots',
    'empties', 'shed-plan', 'deploy-plan', 'job-latency', 'supply', 'eval-report', 'feedback', 'repo-rate', 'runs', 'journal', 'parked', 'slow-prs', 'pr-hygiene', 'merge-batch', 'merge-batch-run', 'rebase-plan', 'merge-plan', 'bus', 'usage', 'research-digest', 'ideation', 'drive', 'wt-census', 'unfed', 'autopilot', 'launches', 'lane-auth', 'reverts', 'vitals',
    // Registered verbs the docs show (see FLEET_SUBCOMMAND_LOADERS). Each one
    // passes test/cli-help-no-side-effects; a registry verb whose --help still
    // misbehaves stays out until it is fixed.
    'activity', 'admission', 'api-pools', 'apps-follow', 'apps-status', 'apps-watch', 'asks',
    'bin-diff', 'brains', 'bridge-check', 'brief-send', 'bus-claim', 'caps-route', 'channel-health', 'ci-plan',
    'claim-bind', 'claim-drift', 'claim-notices', 'config', 'conflict-risk', 'coordination',
    'cos-decline', 'cos-loop', 'cos-reconcile', 'cos-work', 'dep-gate', 'dirty-landed', 'disk',
    'disk-forecast', 'disk-sweep', 'done-evaluate', 'done-plan', 'dot-handoff', 'drift', 'edges',
    'email-outbox', 'empty-merges', 'grok-usage', 'guardian-stuck', 'guardian-verify',
    'handoff-receive', 'handoff-reply', 'health-age', 'heartbeat', 'held', 'hostload',
    'ideation-status', 'idle-lanes', 'imessage-path', 'imessage-tasks', 'intent', 'intent-evidence',
    'intent-import', 'intent-read', 'intent-summary', 'lane-hold', 'lane-idle', 'lane-share',
    'lane-starve', 'lane-target', 'launchable', 'leader-facts', 'leader-health', 'load',
    'login-health', 'machine', 'main-health', 'main-red-age', 'map', 'mason-digest', 'memory',
    'merge-identity', 'merge-latency', 'merge-queue-age', 'merge-retry', 'message-graph', 'metrics',
    'mission', 'needs', 'needs-resolve', 'orchestrate', 'order-state', 'orders', 'org',
    'output-eval', 'owner-history', 'owner-pull', 'peer-ledger', 'pool-reach', 'pools', 'proof',
    'publication-evidence', 'pulse', 'queue-age', 'queue-counts', 'queue-latency', 'queue-repeats',
    'ready-supply', 'rebase-status', 'recheck', 'recheck-record', 'red-merges', 'release-chain',
    'republish', 'resources', 'restock', 'returns-check', 'review-pick', 'roster', 'router-weights',
    'runtime', 'runtime-identity', 'self-tick', 'slack-trace', 'starved', 'status-api',
    'stray-slots', 'stray-stop', 'stuck',
    'stuck-fixes', 'stuck-prs', 'superseded', 'superseded-close', 'surface-owner', 'sync',
    'tailnet-peers', 'teammate-latency', 'teammates', 'trim', 'usage-history', 'waste',
    'work-board', 'work-feed', 'work-result', 'workers', 'worklog', 'worktree-stale', 'wt-audit',
    'yield', 'graph', 'release-backlog',
  ],
  bus: ['thread', 'task', 'board', 'send', 'inbox', 'ack', 'recent', '--since', '--before', '--from', '--to', '--body', '--id', '--priority', '--ttl', '--limit', '--peer', '--root', '--queue-root', '--json', '--help'],
  estates: ['--repo', '--json', '--help'],
  'ci': ['baseline', 'reruns', '--repo', '--json', '--queue', '--queue-file', '--apply', '--help'],
  'ci-metrics': ['--json', '--help'],
  main: ['blame', '--repo', '--good', '--bad', '--check', '--timeout-ms', '--json', '--help'],
  'daily-fix': ['validate', 'filter', 'dispatch', 'parse-fixup', '--json', '--help'],
  recovery: ['list', 'inspect', 'attest', 'abandon'],
  knowledge: ['build', 'impact', 'graph'],
  ask: ['status', '--help', '--json', '--repo', '--allow-cloud', '--jobs'],
  wiki: ['build', 'status', 'show', 'ask'],
  reflect: ['playbooks', 'propose'],
  health: ['propose'],
  goals: [
    'add', 'list', 'show', 'plan', 'advance', 'status', 'recover-stale',
    'repair-timestamps', 'pause', 'resume', 'skip', 'reorder', 'delete',
  ],
  'conductor-permit': ['request', 'mint', 'inspect', 'stage'],
  vision: ['show', 'review', 'preview', 'shadow', 'approve', 'reconcile', 'set'],
  eval: ['attention', 'swe-bench', 'router', 'dataset', 'prompts', 'passk', 'checkpoints'],
  genome: ['recall', 'learn', 'teach', 'consolidate', 'export', 'playbook'],
  comms: ['status', 'thread', 'send-owner', 'send-test', 'cycle', 'ask', 'digest', 'ask-vision', 'ask-merges', 'setup-telegram', 'telegram-brand', 'inbox', 'bus', 'email-drop', 'email-cycle', 'setup-email', 'pair-telegram', 'diagnose', 'health'],
  memory: ['add', 'list', 'search', 'forget', '--kind', '--source', '--json', '--help'],
  library: ['show', 'list', '--kind', '--since', '--q', '--json', '--text', '--help'],
  friction: ['note', '--status', '--owner', '--runs-dir', '--no-record', '--json', '--help'],
  tools: ['parity', 'requires', '--needs', '--text', '--help'],
  messages: ['--since', '--before', '--agent', '--limit', '--text', '--help'],
  connectors: ['add', 'list', 'remove', 'show', 'import', 'run', 'exec', 'config', 'mesh', 'tool', '--json', '--help'],
  agentnet: ['peers', 'channels', 'identity', '--json', '--help'],
  amplify: ['status', 'tick', 'goal', '--json', '--help'],
  channels: ['add', 'status', 'slack', 'map', 'probe', 'run', '--seconds', '--json', '--help'],
  stack: ['status', 'list', 'providers', 'recommend', 'scan', 'doctor', 'add', 'apply'],
  ecosystem: ['doctor', 'changelog'],
  roadmap: ['run', 'resume', 'status'],
  seams: ['status'],
  completions: ['zsh', 'bash'],
  commands: ['--json', '--help'],
  plugins: ['init', 'list', 'info', 'enable', 'disable'],
  skills: ['list', 'audit'],
  pages: ['publish', 'list', '--json', '--help'],
  publish: ['resume', 'orphans', 'sweep', '--branch', '--repo', '--runs-dir', '--apply', '--limit', '--json', '--help'],
  runtime: ['install', 'status', 'rollback', 'run'],
  // Mirrors the verb switch in src/cli/local-runtime.ts (cmdLocalRuntime).
  'local-runtime': ['status', 'start', 'stop', 'restart', 'reshape', 'install', 'uninstall', 'logs', 'resolve-model', 'missing-model-guard'],
  // Mirrors the verb switch in src/cli/authority.ts (runAuthorityCli).
  authority: ['status', 'switch', 'stop', 'clear-stop', 'revoke', 'draft', 'grant', 're-approve', 'ledger', 'surface', 'protect', 'github-app', 'rotate-provenance', 'setup', 'resident', 'claude-signin', 'help'],
  // Mirror the verb switches in src/cli/leader.ts (runLeaderCli) and src/cli/mirror.ts (runMirrorCli).
  // oversight-plist only PRINTS the nightly LaunchAgent (install is by hand) —
  // listed so the verb is discoverable, not hidden behind `leader help`.
  leader: ['show', 'brief', 'run', 'tick', 'veto', 'status', 'ask', 'org', 'assign', 'oversight-plist', 'say', 'thread', 'answer', 'approve', 'directives', 'inbox', 'replies', 'help'],
  mirror: ['list', 'add', 'sync', 'path', 'remove', 'reconcile', 'release', 'help'],
  // Mirror the verb switch in src/cli/cloud.ts (runCloudCli).
  capacity: ['publish'],
  checkpoint: ['resume', '--json', '--help'],
  // Mirror the verb switch in src/cli/caps.ts (cmdCaps).
  caps: ['list', 'validate', 'generate', '--registry', '--out', '--check', '--pin-stage', '--json', '--help'],
  // Mirror the verb switch in src/cli/trail.ts (cmdTrail).
  trail: ['claim', 'beat', 'release', 'save', 'list', 'show', 'resume', 'sweep', '--json', '--help'],
  // Mirror the verb switch in src/cli/sessions.ts (cmdSessions).
  sessions: ['tail', 'thread', 'threads', 'find', 'list', 'revoke', 'create', 'show', 'resume', 'terminate', 'reconcile', 'help', '--lane', '--repo', '--json'],
  cloud: ['launch', 'list', 'refresh', 'improve', 'budget', 'backlog', 'stats', 'help'],
  // Mirror the verb switch in src/cli/jev.ts (runJevCli).
  jev: ['status', 'test', 'help'],
  // Mirror the verb switch in src/cli/devin.ts (runDevinCli).
  bots: ['list', 'show', 'create', 'explain', 'seats', 'handoff', 'handoffs', 'message', 'help'],
  devin: ['connect', 'disconnect', 'seat', 'enable', 'disable', 'fleet', 'status', 'launch', 'list', 'refresh', 'message', 'budget', 'bus', 'land', 'autoland', 'review', 'help'],
  // Mirror the verb switch in src/cli/playbook.ts (runPlaybookCli).
  playbook: ['list', 'show', 'new', 'edit', 'run', 'help'],
  // Mirror the verb switch in src/cli/automations.ts (runAutomationsCli).
  automations: ['list', 'templates', 'add', 'import', 'enable', 'disable', 'remove', 'fire', 'help'],
  // Mirror the verb switch in src/cli/routines.ts (runRoutinesCli).
  routines: ['list', 'status', 'tick', 'migrate', 'launchd', 'run', 'explain', 'export', 'import', 'rebalance', 'help'],
  // Mirrors the dispatch in src/cli/universe.ts (cmdUniverse).
  universe: ['demo', 'init', 'run', 'status', 'archive', 'campaign', 'portfolio', 'integration', 'deliver', 'deliveries', 'graph', 'compare',
    'controller', 'console', 'resources', 'firm', 'preparation-measurement', 'preparation-measurement-capture',
    'preparation-measurement-compare', 'preparation-measurement-calibrate', 'help'],
};

const FLEET_AUTOMERGE_CANARY_SUBCOMMANDS = [
  'status', 'prepare-shadow', 'activate-shadow', 'halt', 'reconcile',
];

function zshScript(): string {
  const subcases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `      ${cmd}) _values 'subcommand' ${subs.map((s) => `'${s}'`).join(' ')} ;;`)
    .join('\n');
  return `#compdef ashlr phm
# Phantom zsh completions — generated by \`phm completions zsh\`; also supports ashlr.
_ashlr() {
  local -a _ashlr_cmds
  _ashlr_cmds=(${TOP_LEVEL_COMMANDS.map((c) => `'${c}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _values 'ashlr command' "\${_ashlr_cmds[@]}"
  elif (( CURRENT == 3 )); then
    case "\${words[2]}" in
${subcases}
      *) _files ;;
    esac
  elif (( CURRENT == 4 )) && [[ "\${words[2]}" == fleet && "\${words[3]}" == automerge-canary ]]; then
    _values 'auto-merge canary command' ${FLEET_AUTOMERGE_CANARY_SUBCOMMANDS.map((s) => `'${s}'`).join(' ')}
  else
    _files
  fi
}
_ashlr "$@"
`;
}

function bashScript(): string {
  const subcases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `      ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`)
    .join('\n');
  return `# Phantom bash completions — generated by \`phm completions bash\`; also supports ashlr.
_ashlr_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${TOP_LEVEL_COMMANDS.join(' ')}" -- "$cur") )
    return 0
  fi
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
${subcases}
      *) COMPREPLY=() ;;
    esac
    return 0
  fi
  if [ "$COMP_CWORD" -eq 3 ] && [ "\${COMP_WORDS[1]}" = "fleet" ] && [ "\${COMP_WORDS[2]}" = "automerge-canary" ]; then
    COMPREPLY=( $(compgen -W "${FLEET_AUTOMERGE_CANARY_SUBCOMMANDS.join(' ')}" -- "$cur") )
    return 0
  fi
  COMPREPLY=()
}
complete -F _ashlr_completions ashlr phm
`;
}

function printCompletionsHelp(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  phm completions') + c.dim(' — shell completion scripts'));
  console.log('');
  console.log('  ' + c.bold('Usage:'));
  console.log('');
  console.log(`    ${c.cyan('phm completions zsh')}    ${c.dim('print zsh completion (_ashlr) to stdout')}`);
  console.log(`    ${c.cyan('phm completions bash')}   ${c.dim('print bash completion to stdout')}`);
  console.log('');
}

export async function cmdCompletions(args: string[]): Promise<number> {
  const shell = args[0];
  // `--help` / `-h` prints usage and never emits a script - even after a shell
  // word (`completions zsh --help` used to dump the zsh script).
  const help = args.includes('--help') || args.includes('-h') || shell === 'help' || shell === undefined;
  if (shell === 'zsh' && !help) {
    process.stdout.write(zshScript());
    return 0;
  }
  if (shell === 'bash' && !help) {
    process.stdout.write(bashScript());
    return 0;
  }
  printCompletionsHelp();
  return help ? 0 : 2;
}

// ---------------------------------------------------------------------------
// "did you mean" (used by the dispatcher's unknown-command path)
// ---------------------------------------------------------------------------

/** Bounded Levenshtein distance (small strings only; zero-dep). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_v, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/**
 * Closest known command for a typo, or null when nothing is plausibly close
 * (distance must be ≤ 2 and less than half the input length).
 */
export function didYouMean(input: string, candidates: readonly string[] = TOP_LEVEL_COMMANDS): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of candidates) {
    const d = editDistance(input.toLowerCase(), cmd);
    if (d < bestDist) {
      bestDist = d;
      best = cmd;
    }
  }
  if (best !== null && bestDist <= 2 && bestDist < Math.max(2, input.length / 2) + 1) {
    return best;
  }
  return null;
}
