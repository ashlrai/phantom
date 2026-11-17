import { readIdeas } from '../core/fleet/ideas.js';
import { QueueIdeaError, queueIdea, readIdeaList, type IdeaListReport } from '../core/fleet/bottleneck-ideas.js';

const USAGE = `Usage: phm ideas [--json]
       phm ideas list [--human]
       phm ideas queue <id> [--json]

  (no verb)     READY fleet ideas from the vision and queue docs.
  list          What the fleet should fix next, ranked from local signals
                (empty launches, main-guardian fixups, disk trend, idle lanes,
                unspent usage). JSON by default; --human for plain lines.
                A signal that cannot be read is listed as unknown.
  queue <id>    Queue one idea from the list as a job (the desktop "Queue it").`;

const isHelp = (args: string[]) => args.length === 1 && ['--help', '-h'].includes(args[0]!);

function human(report: IdeaListReport): string {
  const lines = report.ideas.map((idea, i) => `${i + 1}. ${idea.title}\n   Payoff: ${idea.payoff.text} (score ${idea.payoff.score})\n   Queue: phm ideas queue ${idea.id}`);
  if (lines.length === 0) lines.push('Nothing to fix right now.');
  const unknown = report.signals.filter(signal => signal.status === 'unknown');
  if (unknown.length > 0) lines.push(`Not checked: ${unknown.map(signal => `${signal.name} (${signal.reason})`).join('; ')}`);
  return lines.join('\n');
}

async function cmdIdeasList(args: string[]): Promise<number> {
  if (isHelp(args)) { console.log(USAGE); return 0; }
  if (args.some(arg => arg !== '--human' && arg !== '--json') || args.length > 1) { console.error(USAGE); return 2; }
  const report = await readIdeaList();
  console.log(args.includes('--human') ? human(report) : JSON.stringify(report));
  return 0;
}

async function cmdIdeasQueue(args: string[]): Promise<number> {
  if (isHelp(args)) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const ids = args.filter(arg => arg !== '--json');
  if (ids.length !== 1 || ids[0]!.startsWith('-')) { console.error(USAGE); return 2; }
  try {
    const result = await queueIdea(ids[0]);
    console.log(json ? JSON.stringify(result) : result.queued ? `Queued ${result.ideaId} as job RQ-PHX-${result.jobId}.` : `Already queued as job RQ-PHX-${result.jobId}.`);
    return 0;
  } catch (e) {
    const message = e instanceof QueueIdeaError ? e.message : 'could not queue the idea';
    console.error(json ? JSON.stringify({ error: message }) : `Could not queue: ${message}.`);
    return e instanceof QueueIdeaError && e.status === 400 ? 2 : 1;
  }
}

export async function cmdIdeas(args: string[]): Promise<number> {
  if (args[0] === 'list') return cmdIdeasList(args.slice(1));
  if (args[0] === 'queue') return cmdIdeasQueue(args.slice(1));
  if (isHelp(args)) {
    console.log(USAGE);
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) {
    console.error(USAGE);
    return 2;
  }
  try {
    const report = await readIdeas();
    console.log(args.includes('--json') ? JSON.stringify(report) : report.ideas.map(i => `${i.id} · ${i.repo ?? 'unknown repo'} · ${i.lane ?? 'unknown lane'}: ${i.goal}`).join('\n') || 'No ideas yet.');
    return 0;
  } catch {
    console.error('Could not read ideas.');
    return 1;
  }
}
