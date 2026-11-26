/** Kept import-free so `phm node --help` and `bootstrap` never load the node store. */
export const NODE_FLEET_VERBS = ['join', 'beat', 'enqueue', 'plan', 'pull', 'renew', 'complete', 'release', 'withdraw', 'result', 'status', 'list', 'leave'] as const;

export const NODE_FLEET_USAGE = `Usage: phm node join [--node <id>] --owner <scope[,scope]> [--caps <cap[,cap]>] [--slots 0-64] [--json]
       phm node beat --node <id> --session <n> [--usage 0-1000] [--slots 0-64] [--capacity <sample-json>] [--auth ok|missing|unknown | --probe-auth] [--watch [--every <seconds>]] [--json]
       phm node enqueue --job <id> --owner <scope> [--requires <cap[,cap]>] [--pack <id>] [--secrets <NAME[,NAME]>] [--json]
       phm node plan [--owner <scope>] [--json]
       phm node pull --node <id> --session <n> [--json]
       phm node renew --job <id> --node <id> --session <n> --token <n> --leader-token <n> [--watch [--every <seconds>]] [--json]
       phm node complete --job <id> --node <id> --session <n> --token <n> --leader-token <n> [--result <text>] [--json]
       phm node release --job <id> --node <id> --session <n> --token <n> --leader-token <n> [--decline] [--json]
       phm node withdraw --job <id> --owner <scope> [--json]
       phm node result --job <id> --owner <scope> [--json]
       phm node list|status --owner <scope[,scope]> [--json]
       phm node leave --node <id> --session <n> [--json]
       phm node replica status [--json]
       phm node replica sync [--leader <alias>] [--json]

Computers join Phantom as nodes; \`join\` defaults \`--node\` to this computer's
sanitized hostname (the pool join's default), so \`phm node join --owner <scope>\`
is the shortest first join — pass \`--node\` to choose another id. A job carries an owner scope and only nodes in that scope
see or pull it. The router picks the least-loaded live node that advertises the job's caps
(\`gh\` also needs a local gh-auth heartbeat). A per-job lease with a fencing token means no
job runs twice: renew before it expires and pass the token to every effect. A pulled job the
node will not run is handed back with \`release\` — the job returns to pending at once instead
of holding its lease until expiry; \`--decline\` also bars this session from being offered it
again (a permanent inability such as a missing secret name or a pack the node cannot run).
\`result\`
reads one job's outcome back inside its owner scope — pending, running (with the
claiming node), or completed with the accepted result text — and never changes
anything. State lives in
~/.ashlr/nodes (or $ASHLR_HOME/nodes). Each node uses only its own local login; tokens are
never copied or sent, and jobs carry secret NAMES, never values.

\`beat --watch\` repeats the beat every --every seconds (default 10, at most 25 — sessions
expire 30 s after the last beat) until Ctrl-C, re-measuring capacity and host stats on this
machine each pass unless those flags were given explicitly. \`renew --watch\` repeats the
renew on the same interval so a pulled job's 30-second claim lease survives real work;
the watch flags never reach either verb's parser.`;
