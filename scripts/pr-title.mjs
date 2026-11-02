#!/usr/bin/env node
// PR title helper for the Mac bridge publish step. Usage:
//   node scripts/pr-title.mjs --job RQ-ID [--diff FILE] [--line FILE]
//       [--base-url URL] [--model NAME]
// Prints exactly one line: a `type(scope): summary` title <= 72 chars, or the
// job id when no better source resolves. Reads the built tree (`npm run build`).
try {
  const { readFileSync } = await import('node:fs');
  const {
    createLoopbackCompleter, titleFromDiff, titleFromRouterLine, normalizeTitle,
  } = await import('../dist/core/bridge/pr-title.js');
  const args = process.argv.slice(2);
  const read = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
  };
  const job = read('--job');
  if (!job) {
    console.error('usage: pr-title.mjs --job ID [--diff FILE] [--line FILE] [--base-url URL] [--model NAME]');
    process.exit(2);
  }
  const file = (name) => {
    const path = read(name);
    if (path === null) return null;
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  };
  const diff = file('--diff');
  const line = file('--line');
  const env = process.env;
  const model = read('--model') ?? env.PR_TITLE_MODEL ?? '';
  const baseUrl = read('--base-url') ?? env.PR_TITLE_MODEL_URL ?? undefined;
  let result = null;
  if (diff !== null) {
    const complete = createLoopbackCompleter({ baseUrl, model });
    if (complete) {
      const fromModel = await titleFromDiff(diff, job, complete);
      if (fromModel.source === 'model') result = fromModel;
    }
  }
  // A model fallback still loses to a usable router line; the job id is last.
  if (!result && line !== null) {
    const fromLine = titleFromRouterLine(line, job);
    if (fromLine.source === 'router-line') result = fromLine;
  }
  process.stdout.write(`${result ? result.title : normalizeTitle('', job)}\n`);
} catch {
  // A title failure must never fail publication; the job id is always valid.
  const jobIndex = process.argv.indexOf('--job');
  const fallback = jobIndex >= 0 ? process.argv[jobIndex + 1] : 'bridge-job';
  process.stdout.write(`${fallback ?? 'bridge-job'}\n`);
}
process.exit(0);
