/** Kept in parity with restock.py by the queue-dedupe fixtures. No model calls. */
export function semanticDedupe(text: string) {
  const lines = text.split(/(?<=\n)/);
  const unknown: { id: string | null; line: number; reason: string }[] = [];
  const rows = lines.flatMap((line, index) => {
    if (!/^\s*-\s+(READY|CLAIMED|RUNNING)\b/i.test(line)) return [];
    const m = /^\s*-\s+(READY|CLAIMED|RUNNING)\s+(?:\S+\s+)*?([\w.-]+)(?: r\d+)?\s+\(([^)]*)\):\s*(.*)/i.exec(line);
    const repo = /\brepo=(?:ashlrai\/)?([\w.-]+)(?=[,;\s)]|$)/i.exec(m?.[3] ?? '')?.[1]?.toLowerCase();
    const goal = (m?.[4] ?? '').toLowerCase();
    const target = /(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:tsx?|mjs|cjs|jsx?|py|rs|go|md|json|ya?ml|toml|sh|css|html)\b|\bmodule\s+`?[\w.-]+`?/g;
    const files = new Set((goal.match(target) ?? []).map(s => s.replace(/^module\s+`?/, '').replace(/`$|\.+$/g, '')));
    const tokens = new Set((goal.replace(target, ' ').replace(/\b(?:add\s+)?(?:one|single|1)[ -](?:test[ -])?case\b/g, ' ').match(/[a-z0-9]+/g) ?? []).filter(t => !/^(a|an|the|to|in|of|and|or|for|with|at|on|by|is|it|be|as|acceptance)$/.test(t)));
    if (!m || !repo || !files.size || tokens.size < 3) {
      unknown.push({ id: m?.[2] ?? null, line: index + 1, reason: 'Missing id, repo, file/module, or three goal tokens' });
      return [];
    }
    const prs = [...`${m[3]} ${goal}`.matchAll(/(?:\bpr[=#]|#|\/pull\/)(\d+)/gi)].map(p => p[1]).sort().join(',');
    return [{ id: m[2]!, repo, files, tokens, prs, index, ready: m[1]!.toUpperCase() === 'READY' }];
  });
  const kept = rows.filter(r => !r.ready);
  const repeats: { id: string; repeatOf: string; repo: string; file: string; match: 'semantic-goal'; reason: 'semantic-goal-overlap'; jaccard: number }[] = [];
  for (const row of rows.filter(r => r.ready)) {
    const prior = kept.find(p => p.id !== row.id && p.repo === row.repo && p.prs === row.prs && [...p.files].some(f => row.files.has(f)) &&
      [...p.tokens].filter(t => row.tokens.has(t)).length / new Set([...p.tokens, ...row.tokens]).size >= 0.5);
    if (!prior) { kept.push(row); continue; }
    const jaccard = [...prior.tokens].filter(t => row.tokens.has(t)).length / new Set([...prior.tokens, ...row.tokens]).size;
    repeats.push({ id: row.id, repeatOf: prior.id, repo: row.repo, file: [...prior.files].filter(f => row.files.has(f)).sort()[0]!, match: 'semantic-goal', reason: 'semantic-goal-overlap', jaccard });
    lines[row.index] = lines[row.index]!.replace(/^(\s*-\s+)READY\b/i, `$1DUPLICATE-OF-${prior.id}`);
  }
  return { repeats, unknown, output: lines.join('') };
}
