export interface FleetVerbEntry {
  verb: string;
  usage: string | null;
  summary: string | null;
  effect: FleetVerbEffect;
}

export type FleetVerbEffect = 'read' | 'apply-gated' | 'writes' | 'unknown';

// Effect inference — the fact the agent-native order needs: an agent reading
// `fleet verbs --json` must know which verbs only read and which change the
// fleet. Classification scans the verb's own source text; helpers in src/core
// stay invisible, so the CLI file's own signals decide. Fail safe: doubt
// resolves to 'writes', never 'read'.
//
//   'unknown'     source could not be read.
//   'apply-gated' source parses an opt-in mutating flag ('--apply', '--write',
//                 '--flush') — the default stays a dry run.
//   'writes'      no gate, but a write path appears in the source.
//   'read'        none of those signals.
//
// Write-path patterns, deliberately small:
//   GATE_FLAG_RE      a quoted opt-in mutating flag literal as parsed by argv
//                     handling; usage text "[--apply]" does not match.
//   FS_WRITE_RE       node:fs mutation calls: writeFile/appendFile/writeSync/
//                     rename/unlink/rm/mkdir, bare or Sync forms.
//   TOOL_CALL_RE      a runner call whose process is gh or git —
//                     execFile('git', …), run('gh', …), the gh([…])/git([…]) seam.
//   GH_MUT_ARGV_RE    an argv array literal naming a mutating gh subcommand —
//                     ['pr', 'close' …], or gh api carrying POST/PUT/PATCH/DELETE.
//   GIT_MUT_ARGV_RE   an argv array literal naming a mutating git subcommand —
//                     ['push' …], ['commit' …], ['checkout' …].
//   SEND_HELPER_RE    a camelCase helper named for a mutating act: a leading
//                     mutating word (sendEmailOutbox, postBusReply,
//                     resolveNeedsMasonWithInbox, runContextReply), or an inner
//                     Claim/Continue/Retry word (waitClaimBusWork). Matched at
//                     word boundary so dep defaults and (a ?? helper)( calls
//                     count, not only direct invocations. Read-ish leading
//                     words stay out: read, list, get, fetch, check, plan,
//                     queue, merge, pull, exec, spawn, sync.
//   READ_ONLY_HELPERS names SEND_HELPER_RE must not flag: listeners, timers,
//                     fs fd calls shared by readers (closeSync/openSync/
//                     readSync), crypto and stream factories, and observed
//                     pure names (measure helpers, predicates, result
//                     builders, parameter variables).
const GATE_FLAG_RE = /['"`](?:--apply|--write|--flush)['"`]/;
const FS_WRITE_RE = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|writeSync|renameSync|rename|unlinkSync|unlink|rmSync|rm|mkdirSync|mkdir)\s*\(/;
const TOOL_CALL_RE = /\b(?:execFileSync|execFile|execSync|exec|execFileAsync|spawnSync|spawn|spawnAsync|run|runner|runGh|runGit|ghRunner|gitRunner|defaultGitRunner)\s*\(\s*['"`](?:gh|git)['"`]|\b(?:gh|git)\s*\(\s*\[/;
const GH_MUT_ARGV_RE = /\[\s*['"](?:pr|issue|release|workflow|repo|secret|variable|cache|project|ruleset|label|auth|gist|extension|alias|codespace|org|search|run)['"]\s*,\s*['"](?:close|merge|create|edit|comment|reopen|ready|review|rerun|cancel|delete|enable|disable|set|sync|archive|fork|checkout|transfer|apply|add|remove|login|logout|resolve|mark|install|uninstall|pin|unpin|lock|unlock|copy|move|rename)['"]|\[\s*['"]api['"][^\][]*['"](?:POST|PUT|PATCH|DELETE)['"]/;
const GIT_MUT_ARGV_RE = /\[\s*['"](?:push|commit|merge|rebase|reset|checkout|switch|restore|clean|mv|tag|branch|fetch|pull|clone|init|add|apply|cherry-pick|revert|stash|gc|prune|worktree|update-ref|commit-tree|write-tree|am|bisect|filter-branch)['"]/;
const HELPER_LEAD = '(?:send|post|deliver|mutate|reply|request|claim|resolve|record|submit|publish|enqueue|notify|schedule|retry|sweep|drain|mark|store|save|persist|register|install|uninstall|apply|write|append|insert|update|delete|remove|close|land|signal|stop|set|create|add|complete|terminate|kill|dispatch|grant|revoke|run|rotate|archive|prune|transfer|cancel|assign|acquire|lock|broadcast|announce|invite|emit|reserve|reassign|hold|place|compact|prepare|ensure|launch|start|reap|flush|purge|reconcile|cleanup|repair|remediate|restart|enable|disable|open|receive)';
const HELPER_INNER = '(?:Claim|Continue|Retry)';
const SEND_HELPER_RE = new RegExp(`\\b${HELPER_LEAD}[A-Z][A-Za-z0-9]*\\b|\\b[a-z][a-zA-Z0-9]*${HELPER_INNER}[A-Za-z0-9]*\\b`, 'g');
const READ_ONLY_HELPERS = new Set([
  'addEventListener', 'removeEventListener', 'removeListener', 'removeSignalListeners', 'removeAllListeners',
  'setImmediate', 'setInterval', 'setTimeout', 'queueMicrotask', 'closeSync', 'openSync', 'readSync',
  'createHash', 'createHmac', 'createReadStream', 'createInterface', 'createRequire', 'createGunzip',
  'createBrotliDecompress', 'createInflate', 'createUnzip', 'createDecipheriv', 'createDecipher', 'createSign',
  'createVerify', 'createSecretKey', 'createPrivateKey', 'createPublicKey', 'createDiffieHellman', 'createECDH',
  'dispatchEventsCandidates', 'dispatchSummaryReason',
  'resolveFleetSubcommand', 'resolveDropJobRoot', 'resolveText',
  'completeAttempts', 'recordOf', 'replyResult', 'replyReceipt', 'replyId', 'replyStdin',
  'requestFile', 'requestId', 'requestPath',
  'stopFile', 'stopReasons', 'stopExists', 'stopSleep', 'stopDeps', 'stopText', 'stopFileExists',
  'runId', 'runUrl', 'runText', 'runStatus', 'runCandidates', 'runFleetDoctor', 'runStandbyReadiness',
  'launchCount', 'launchRepo', 'launchDedupe', 'launchMs', 'launchLane', 'launchProofCheck',
  'startLine', 'startColumn', 'openPrs', 'openOver30m', 'sendArgs', 'scheduleDirectory',
  'retryOutputDir', 'retrySkipped', 'execPath', 'holdMinutes', 'holdArg', 'drainDeps', 'drainPaths',
  'observedClaims', 'unmatchedClaims',
]);

export function inferVerbEffect(source: string | null): FleetVerbEffect {
  if (source === null) return 'unknown';
  if (GATE_FLAG_RE.test(source)) return 'apply-gated';
  if (FS_WRITE_RE.test(source)) return 'writes';
  if (TOOL_CALL_RE.test(source) && (GH_MUT_ARGV_RE.test(source) || GIT_MUT_ARGV_RE.test(source))) return 'writes';
  for (const match of source.matchAll(SEND_HELPER_RE)) {
    if (!READ_ONLY_HELPERS.has(match[0])) return 'writes';
  }
  return 'read';
}

export function extractVerbSummary(source: string, verb: string): { usage: string | null; summary: string | null } {
  let usage: string | null = null;
  // Some older commands spell this constant `usage` and use a multiline template.
  const constants = /\bconst\s+usage\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/gi;
  for (const match of source.matchAll(constants)) {
    const firstLine = match[2].split(/\r?\n/)[0].trim();
    if (firstLine.includes(`fleet ${verb}`)) {
      usage = firstLine.replace(/^Usage:\s*/i, '');
      break;
    }
  }
  const comment = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  const cleaned = comment?.[1].replace(/^\s*\*\s?/gm, '').replace(/`/g, '')
    .replace(/\b(?:\.\.\/|\.\/|[\w.-]+\/)+(?=[\w.-])/g, '').replace(/\s+/g, ' ').trim();
  const sentence = cleaned?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? cleaned;
  return { usage, summary: sentence ? sentence.slice(0, 160) : null };
}

export function buildFleetVerbCatalog(verbs: string[], readSource: (verb: string) => string | null): FleetVerbEntry[] {
  return [...verbs].sort().map(verb => {
    const source = readSource(verb);
    const effect = inferVerbEffect(source);
    return { verb, ...(source === null ? { usage: null, summary: null } : extractVerbSummary(source, verb)), effect };
  });
}
