/** Kept import-free so `phm node --help` and `bootstrap` never load the node store. */
export const NODE_FLEET_VERBS = ['join', 'beat', 'enqueue', 'plan', 'pull', 'renew', 'complete', 'status', 'leave'] as const;

export const NODE_FLEET_USAGE = `Usage: phm node join --node <id> --owner <scope[,scope]> [--caps <cap[,cap]>] [--json]
       phm node beat --node <id> --session <n> [--usage 0-1000] [--auth ok|missing|unknown | --probe-auth] [--json]
       phm node enqueue --job <id> --owner <scope> [--requires <cap[,cap]>] [--pack <id>] [--secrets <NAME[,NAME]>] [--json]
       phm node plan [--owner <scope>] [--json]
       phm node pull --node <id> --session <n> [--json]
       phm node renew|complete --job <id> --node <id> --session <n> --token <n> --leader-token <n> [--result <text>] [--json]
       phm node status --owner <scope[,scope]> [--json]
       phm node leave --node <id> --session <n> [--json]

Computers join Phantom as nodes. A job carries an owner scope and only nodes in that scope
see or pull it. The router picks the least-loaded live node that advertises the job's caps
(\`gh\` also needs a local gh-auth heartbeat). A per-job lease with a fencing token means no
job runs twice: renew before it expires and pass the token to every effect. State lives in
~/.ashlr/nodes (or $ASHLR_HOME/nodes). Each node uses only its own local login; tokens are
never copied or sent, and jobs carry secret NAMES, never values.`;
