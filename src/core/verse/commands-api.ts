/**
 * GET /api/verse/commands — the `phm commands` catalog for the desktop palette.
 * GET /api/verse/commands/run?name=<name> — run ONE catalog command and return
 * its output, only when the catalog says it is read-only and needs no input.
 * The argv is the catalog name, never caller text; a state-changing command is
 * refused here (the palette confirms it and hands it to the Terminal).
 */
import { execFile } from 'node:child_process';
import { buildCommandCatalog, COMMANDS_SCHEMA, type CatalogCommand } from '../commands/catalog.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export interface CommandRun { exitCode: number | null; output: string }
export type CommandRunner = (argv: string[]) => Promise<CommandRun>;

const ROUTE = '/api/verse/commands';
const MAX_OUTPUT_CHARS = 64_000;

/** This same CLI, bounded: 20 s, capped output, no colour codes. */
const runSelf: CommandRunner = (argv) => new Promise((resolve) => {
  execFile(process.execPath, [...process.execArgv, process.argv[1]!, ...argv],
    { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
    (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      output: `${stdout}${stderr}`.trim().slice(0, MAX_OUTPUT_CHARS),
    }));
});

/** The help table is large, so it loads on the first request, not when the route mounts. */
let loaded: Promise<CatalogCommand[]> | null = null;
const loadCatalog = (): Promise<CatalogCommand[]> => (loaded ??= import('../../cli/help.js').then((help) => buildCommandCatalog(help.HELP_ENTRIES)));

export function createCommandsApi(run: CommandRunner = runSelf, catalog: () => Promise<CatalogCommand[]> = loadCatalog): ApiModule {
  let running = 0;
  return async (_ctx, req, res, path, method) => {
    if (path !== ROUTE && path !== `${ROUTE}/run`) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const commands = await catalog();
    if (path === ROUTE) {
      sendJson(res, 200, { schema: COMMANDS_SCHEMA, commands });
      return true;
    }
    const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
    const command = commands.find((candidate) => candidate.name === name);
    if (!command) sendJson(res, 404, { error: 'unknown command' });
    else if (command.changesState || command.needsInput) sendJson(res, 403, { error: 'Only read-only commands that need no input run here.' });
    else if (running >= 2) sendJson(res, 429, { error: 'Two commands are already running. Try again in a moment.' });
    else {
      running += 1;
      try { sendJson(res, 200, await run(command.name.split(' '))); } finally { running -= 1; }
    }
    return true;
  };
}

export const handleCommandsApi: ApiModule = createCommandsApi();
