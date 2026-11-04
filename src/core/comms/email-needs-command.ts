import type { listNeedsMason, NeedsMasonOptions } from '../fleet/needs-mason-resolve.js';
import { parseResolveCommand, type NeedsCommandReply, type TelegramNeedsCommandDeps } from './telegram-needs-command.js';

const COMMAND = /^\s*\/(needs|resolve)(?![\w-])/i;

/** The command line: first non-empty body line, or the subject when the body is empty. */
function commandLine(text: string): string {
  return text.split(/\r?\n/).find(line => line.trim()) ?? '';
}

/** Callers pass the trimmed body, or the subject when the body is empty. */
export function isEmailNeedsCommand(text: string): boolean {
  return COMMAND.test(commandLine(text.trim()));
}

export interface EmailNeedsCommandDeps {
  list: typeof listNeedsMason;
  resolve: TelegramNeedsCommandDeps['resolve'];
  runsDir: string;
}

export async function runEmailNeedsCommand(text: string, deps: EmailNeedsCommandDeps): Promise<NeedsCommandReply> {
  const line = commandLine(text.trim());
  const command = COMMAND.exec(line)?.[1]?.toLowerCase() === 'needs' ? 'needs' : 'resolve';
  const options: NeedsMasonOptions = { runsDir: deps.runsDir, source: 'email' };
  try {
    if (command === 'needs') return { status: 'list', items: deps.list(options) };
    const request = parseResolveCommand(line);
    if (!request) return { status: 'usage' };
    const result = await deps.resolve(request, options);
    if (result.ok) return { status: 'resolved', itemId: result.itemId, ...(result.inbox ? { inbox: result.inbox } : {}) };
    if (result.code !== 'unavailable') return { status: 'refused', code: result.code };
  } catch {
    // Fall through: the reply never carries the error text.
  }
  return { status: 'failed', command };
}
