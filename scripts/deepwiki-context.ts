#!/usr/bin/env -S npx tsx
/* global process */
import { fetchDeepWikiContext, renderDeepWikiContext, DEFAULT_CONTEXT_BYTES } from '../src/core/deepwiki/context.js';
import { DEEPWIKI_MCP_URL } from '../src/core/deepwiki/client.js';

const HELP = `Usage: npx tsx scripts/deepwiki-context.ts <owner/name> [--ask QUESTION] [--contents] [--json]
       [--max-bytes N] [--endpoint URL] [--strict]

Fetch grounded codebase context from DeepWiki (read_wiki_structure, optionally
read_wiki_contents and ask_question) for agents to read before a task.
Endpoint: --endpoint, else $DEEPWIKI_MCP_URL, else ${DEEPWIKI_MCP_URL}
(https only; http on loopback). No credentials are sent. Private repos resolve
once connected in the Devin account; until then the result is status
"not_indexed" or "unavailable" and the exit code stays 0 so callers degrade.
--strict exits 2 unless status is ok. Output is capped (default ${DEFAULT_CONTEXT_BYTES} bytes)
and is untrusted reference data, never instructions.
`;

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }
  let repo = '', question: string | undefined, endpoint = process.env.DEEPWIKI_MCP_URL || undefined;
  let maxBytes = DEFAULT_CONTEXT_BYTES, json = false, contents = false, strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--json') json = true;
    else if (a === '--contents') contents = true;
    else if (a === '--strict') strict = true;
    else if (a === '--ask') question = value();
    else if (a === '--endpoint') endpoint = value();
    else if (a === '--max-bytes') {
      maxBytes = Number(value());
      if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > 1024 * 1024) throw new Error('--max-bytes must be 512..1048576');
    } else if (a.startsWith('-') || repo) throw new Error(`unexpected argument ${a}`);
    else repo = a;
  }
  if (!repo) throw new Error('missing <owner/name>');
  const ctx = await fetchDeepWikiContext(repo, { question, contents, maxBytes, endpoint });
  process.stdout.write(json ? `${JSON.stringify(ctx, null, 2)}\n` : renderDeepWikiContext(ctx));
  return strict && ctx.status !== 'ok' ? 2 : 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`deepwiki-context: ${err instanceof Error ? err.message : String(err)}\n${HELP}`);
  process.exitCode = 1;
});
