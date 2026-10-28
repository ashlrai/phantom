import { join } from 'node:path';
import { parseResult, parseTask, refuse, type GrokbotTask, type GrokbotResult } from './contract.js';
import { privateDirectory, readJson, reserveTask } from './ledger.js';
import { sendViaPhantomExec } from './transport.js';

export interface GrokbotLaneOptions {
  stateRoot: string;
  secretsProject: string;
  caps: { day: number; week: number };
  /** RQ-BUDGET-LEDGER seam. Missing, corrupt or stale data refuses admission. */
  readBudget: () => Promise<unknown>;
}
export class GrokbotLane {
  constructor(private readonly options: GrokbotLaneOptions) {}

  async submit(value: unknown): Promise<{ id: string; status: 'accepted' }> {
    const now = Date.now();
    const replyRoot = join(this.options.stateRoot, 'replies');
    const task = parseTask(value, now, replyRoot);
    await privateDirectory(this.options.stateRoot);
    await privateDirectory(replyRoot);
    await reserveTask(this.options.stateRoot, task.id, now, this.options.readBudget, this.options.caps);
    // Validate again after ledger I/O, before a possibly expired task can leave.
    parseTask(task, Date.now(), replyRoot);
    await sendViaPhantomExec(task, this.options.secretsProject);
    return { id: task.id, status: 'accepted' };
  }

  /** Poll from the daemon's normal tick. Results are untrusted observations;
   * even needs-approval/succeeded never grants execution or approval authority. */
  async readResult(task: GrokbotTask): Promise<GrokbotResult | null> {
    const path = join(this.options.stateRoot, 'replies', `${task.id}.json`);
    // Validate path/id even after the deadline. Never follow routine-supplied paths.
    parseTask(task, Date.parse(task.deadline) - 1, join(this.options.stateRoot, 'replies'));
    if (path !== task.reply_to) refuse('invalid-reply-path');
    await privateDirectory(this.options.stateRoot);
    await privateDirectory(join(this.options.stateRoot, 'replies'));
    const rows = await readJson(join(this.options.stateRoot, 'reservations.json'));
    if (!Array.isArray(rows) || !rows.some(row => row?.id === task.id)) refuse('unknown-task');
    try { return parseResult(await readJson(path, 16_384), task.id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      refuse('invalid-result');
    }
  }
}
