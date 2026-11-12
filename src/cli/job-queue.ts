import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { importMarkdown } from '../core/queue/markdown.js';
import { loadMergedJobIds, QueueStore } from '../core/queue/store.js';
import { createSpawnIngest, loadOrCreateIngestToken } from '../core/queue/ingest.js';
import { validateQueue, type QueueDocument } from '../core/queue/schema.js';
import { draftCosResult } from '../core/cos/intake.js';
import { dirname, join } from 'node:path';

const HELP = `Usage: phm queue <command> [--dir <queue-directory>] [--json]
  add <id> --priority P0 --pool <pool> --tier <tier> --repo <repo>
      --scope <text> --acceptance <text> [--deps <id,id>]
  claim <id> --owner <worker>
  done <id> --owner <worker> [--pr-url <https-url>] [--result <text>]
  block <id> --owner <worker> --reason <text>
  replay --failed [--since <iso>] [--query <text>]
      [--mode replay_failed|replay_failed_and_dependents] [--dry-run]
  spawn <spawn.json|->              Apply a bounded spawn.v1 decomposition proposal
  promote <id>                      Admit a PROPOSED job as READY (operator act)
  serve [--port <n>] [--token-file <path>]
                                    Loopback-only spawn ingest API (127.0.0.1)
  list
  import <router-queue.md|queue.json>   Bootstrap an empty queue
  export [--md]                       JSON to stdout; --md writes queue.mirror.md
With --pr-url, done records PR-OPEN; done without it records DONE.
Claims require READY and all dependencies DONE. No fleet cutover is performed.
Spawn children land as PROPOSED: deduped, rate-limited, depth-capped and
never allowed a higher tier, tighter priority, other pool or other repo.`;
async function readStdin(cap: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > cap) throw new Error('Proposal on stdin is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function cmdJobQueue(args: string[]): Promise<number> {
  let json = args.includes('--json');
  try {
    const { values: parsedValues, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      failed: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, md: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      ...Object.fromEntries(['since', 'query', 'mode', 'dir', 'priority', 'pool', 'tier', 'repo', 'scope', 'acceptance', 'deps', 'owner', 'pr-url', 'reason', 'result', 'port', 'token-file'].map(key => [key, { type: 'string' as const }])),
    } });
    const values: Record<string, string | boolean | undefined> = parsedValues;
    json = values.json === true;
    if (values.help || !positionals.length) { console.log(HELP); return 0; }
    const [command, operand] = positionals;
    const allowed: Record<string, string[]> = {
      add: ['priority', 'pool', 'tier', 'repo', 'scope', 'acceptance', 'deps'], claim: ['owner'],
      replay: ['failed', 'since', 'query', 'mode', 'dry-run'], done: ['owner', 'pr-url', 'result'], block: ['owner', 'reason'], list: [], import: [], export: ['md'],
      spawn: [], serve: ['port', 'token-file'], promote: [],
    };
    if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown queue command: ${command}`);
    if (positionals.length !== (['replay', 'list', 'export', 'serve'].includes(command) ? 1 : 2)) throw new Error('Unexpected or missing operand');
    for (const key of Object.keys(values)) if (!['dir', 'json', ...allowed[command]].includes(key)) throw new Error(`Unsupported option for ${command}: --${key}`);
    const required = (key: string): string => {
      const value = values[key];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Required: --${key}`);
      return value;
    };
    const store = new QueueStore(typeof values.dir === 'string' ? values.dir : undefined);
    let result: unknown;
    switch (command) {
      case 'replay':
        if (!values.failed) throw new Error('Required: --failed');
        result = await store.replay({ since: values.since as string | undefined, query: values.query as string | undefined, mode: values.mode as import('../core/queue/replay.js').ReplayOptions['mode'], dryRun: values['dry-run'] === true }); break;
      case 'add': result = await store.add({ id: operand, status: 'READY', priority: required('priority'), pool: required('pool'), tier: required('tier'), repo: required('repo'), scope: required('scope'), acceptance: required('acceptance'), deps: typeof values.deps === 'string' ? values.deps.split(',') : [], claims: [] }); break;
      case 'claim': result = await store.claim(operand, required('owner')); break;
      case 'done': {
        if (operand.startsWith('cos-')) {
          const job = (await store.read()).jobs.find(job => job.id === operand);
          if (!job || job.status !== 'CLAIMED' || job.claims.at(-1)?.owner !== required('owner')) throw new Error('An active claim owned by --owner is required');
          if (values['pr-url']) throw new Error('Chief-of-staff completion requires a result, not a PR handoff');
          await draftCosResult(operand, required('result'), dirname(store.directory));
        } else if (values.result) throw new Error('--result requires a chief-of-staff job');
        result = await store.finish(operand, required('owner'), { prUrl: typeof values['pr-url'] === 'string' ? values['pr-url'] : undefined }); break;
      }
      case 'block': result = await store.finish(operand, required('owner'), { reason: required('reason') }); break;
      case 'import': {
        const text = await readFile(operand, 'utf8');
        const doc: QueueDocument = operand.endsWith('.json') ? JSON.parse(text) : importMarkdown(text);
        validateQueue(doc);
        for (const warning of doc.warnings ?? []) console.error(`queue import: ${warning}`);
        result = await store.import(doc); break;
      }
      case 'export': result = values.md ? { path: await store.mirror() } : await store.read(); break;
      case 'list': result = await store.read(); break;
      case 'promote': result = await store.promote(operand); break;
      case 'spawn': {
        const cap = 256 * 1024;
        const text = operand === '-'
          ? await readStdin(cap)
          : await readFile(operand, 'utf8');
        if (Buffer.byteLength(text) > cap) throw new Error('Proposal file is too large');
        result = await store.propose(JSON.parse(text), { mergedIds: await loadMergedJobIds(dirname(store.directory)) });
        break;
      }
      case 'serve': {
        let port = 0;
        if (values.port !== undefined) {
          port = Number(values.port);
          if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be 0-65535');
        }
        const tokenPath = typeof values['token-file'] === 'string' ? values['token-file'] : join(store.directory, 'spawn-ingest.token');
        const token = await loadOrCreateIngestToken(tokenPath);
        const ingest = await createSpawnIngest({ token, port,
          apply: (proposal) => loadMergedJobIds(dirname(store.directory))
            .then(mergedIds => store.propose(proposal, { mergedIds })) });
        result = { listening: `127.0.0.1:${ingest.port}`, tokenFile: tokenPath };
        break;
      }
    }
    console.log(JSON.stringify(result, null, json ? undefined : 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue operation failed';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
