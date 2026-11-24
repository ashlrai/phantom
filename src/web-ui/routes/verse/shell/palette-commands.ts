/**
 * routes/verse/shell/palette-commands.ts — the ⌘K palette's Commands group:
 * the SAME catalog `phm commands --json` prints (core/commands/catalog.ts),
 * read from GET /api/verse/commands. Nothing is listed here by hand.
 */
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { CatalogCommand } from '../../../../core/commands/catalog.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The wire catalog, validated; a malformed row is dropped, never guessed at. */
export function paletteCliCommands(read: unknown): CatalogCommand[] {
  if (!record(read) || !Array.isArray(read.commands)) return [];
  return read.commands.filter((row): row is CatalogCommand => record(row) && typeof row.name === 'string' && row.name !== ''
    && typeof row.description === 'string' && Array.isArray(row.arguments) && row.arguments.every((form) => typeof form === 'string')
    && typeof row.changesState === 'boolean' && typeof row.needsInput === 'boolean');
}

export const paletteCommandsQuery: QueryDef<CatalogCommand[]> = {
  key: 'verse-palette-commands',
  async fetch(signal) {
    try {
      return paletteCliCommands(await apiGet<unknown>('/api/verse/commands', signal));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return [];
      throw error;
    }
  },
};

/**
 * What Enter on a command does. `run`: read-only and needs nothing, so it
 * runs right here. `confirm`: it changes state, so the palette asks first.
 * `fill`: read-only but needs input, so the line goes to the Terminal to finish.
 */
export function cliStep(command: CatalogCommand): 'run' | 'confirm' | 'fill' {
  return command.changesState ? 'confirm' : command.needsInput ? 'fill' : 'run';
}

/** Run a read-only command on the server; the text to show, whatever happened. */
export async function runCliCommand(name: string): Promise<string> {
  const result = await apiGet<{ exitCode: number | null; output: string }>(`/api/verse/commands/run?name=${encodeURIComponent(name)}`);
  return result.output || (result.exitCode === 0 ? 'Done. It printed nothing.' : 'It stopped without printing anything.');
}
