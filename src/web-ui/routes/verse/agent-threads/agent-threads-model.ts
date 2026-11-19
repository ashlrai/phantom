/**
 * Agent threads, the pure half: every agent session as a conversation. Built only on reads the console already
 * has: the `phm sessions --json` list (fleet.live-sessions.v1), one job's recorded activity
 * (fleet.job.activity.v1) and the agent bus messages (`phm messages`). Nothing is invented: a fact a read does
 * not hold says "unknown", and the summary is assembled from those records, never written by a model.
 */
import type { AgentMessage } from '../../../../core/fleet/agent-messages.js';
import { flatTree, sessionAge, spoke, type LiveSessionRow, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { eventTimeLabel, type JobActivityV1 } from '../fleet-job-log/job-activity-model.js';

export type ThreadState = 'quiet' | 'running' | 'failed' | 'idle' | 'done' | 'unknown';
export interface AgentThread {
  node: SessionNode;
  /** The running session's own row (quiet, age, PR, computer), when the list holds one. */
  row: LiveSessionRow | undefined;
  state: ThreadState;
  /** The session this one reports to, when it is not the leader. */
  parent: string | null;
}

const RANK: Readonly<Record<ThreadState, number>> = { quiet: 1, running: 2, failed: 3, idle: 4, done: 5, unknown: 6 };
const named = (word: string, value: string) => (value === 'unknown' ? `${word} unknown` : value);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The leader first, then the sessions to look at (quiet), running, failed, and the rest; the tree's most-recent-first order is kept inside each. */
export function agentThreads(list: LiveSessionsV1): AgentThread[] {
  const rows = new Map(list.sessions.map(row => [row.job, row]));
  return flatTree(list.tree.roots).filter(({ node }) => node.kind !== 'unknown-parent').map(({ node }, index) => {
    const row = node.jobId === null ? undefined : rows.get(node.jobId);
    const state: ThreadState = node.state === 'running' && row?.quiet === true ? 'quiet' : node.state;
    return { index, rank: node.kind === 'leader' ? 0 : RANK[state], thread: { node, row, state, parent: node.kind === 'leader' ? null : node.parentId } };
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ thread }) => thread);
}

/** The one-line read under a thread's name: what it is and where. */
export function threadFacts({ node }: AgentThread): string {
  return [node.kind, node.agent !== node.id && node.agent !== 'unknown' ? node.agent : null, named('repo', node.repo)].filter(Boolean).join(' · ');
}

/** The state in words, for the mark beside the name. */
export function stateWord({ state }: AgentThread): string {
  return state === 'unknown' ? 'state unknown' : state;
}

/**
 * The thread's summary: short sentences assembled from the records. `activity` is undefined while it is being
 * read and null when this session records none.
 */
export function threadSummary(thread: AgentThread, activity: JobActivityV1 | null | undefined): string[] {
  const { node, row, state } = thread;
  const kind = node.kind === 'subagent' ? 'Helper' : node.kind === 'leader' ? 'Leader' : 'Worker';
  const lines = [`${kind} on ${named('lane', node.lane)}, ${named('model', node.model)}, in ${named('repo', node.repo)}.`];
  const said = node.lastMessageAgeSeconds === null ? 'last spoke unknown' : spoke(node);
  if (state === 'quiet') lines.push(`Quiet: no output for ${sessionAge(row?.lastOutputAgeSeconds ?? node.lastMessageAgeSeconds)}.`);
  else if (state === 'running') lines.push(`Running for ${sessionAge(row?.ageSeconds ?? null)}; ${said}.`);
  else if (state === 'unknown') lines.push(`State unknown; ${said}.`);
  else lines.push(`${state[0]!.toUpperCase()}${state.slice(1)}; ${said}.`);
  if (node.counts.below > 0) lines.push(`${node.counts.running} of ${plural(node.counts.below, 'helper')} running${node.counts.failed ? `, ${node.counts.failed} failed` : ''}.`);
  if (activity === null) lines.push('No activity is recorded for this session.');
  else if (activity) {
    const entries = activity.entries ?? [];
    const commands = activity.counts?.commands, files = entries.find(entry => entry.kind === 'files');
    const changed = !files || files.state === 'missing' ? 'changed files unknown'
      : `${plural(files.totals.files, 'file')} changed (+${files.totals.added} −${files.totals.removed})${files.state === 'degraded' ? ', partial' : ''}`;
    lines.push(`${commands == null ? 'Commands unknown' : `${plural(commands, 'command')} seen`}, ${changed}.`);
    const last = entries.filter(entry => entry.kind === 'event').at(-1);
    if (last) lines.push(`Latest step: ${[last.event, last.summary].filter(Boolean).join(' ')}${last.at ? ` at ${eventTimeLabel(last.at)}` : ''}.`);
    if (activity.truncated) lines.push('Older activity is outside the recorded window.');
  }
  return lines;
}

export interface ThreadBubble {
  key: string;
  /** `agent` is this session speaking, `other` is someone speaking to it, `system` is a recorded step. */
  side: 'agent' | 'other' | 'system';
  label: string;
  when: string;
  text: string;
  format: 'plain' | 'mono' | 'markdown';
}

const COMMANDS_SHOWN = 8, FILES_SHOWN = 6;

/** The messages about one session on the bus, oldest first: the ones naming its job, or sent by or to it. */
export function threadMessages(thread: AgentThread, messages: readonly AgentMessage[]): AgentMessage[] {
  const { id, jobId } = thread.node;
  return messages.filter(m => (jobId !== null && m.job === jobId) || m.from.name === id || m.to.name === id)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/**
 * The thread, in the order a conversation reads: the brief it was given, the recorded steps, what it ran and
 * changed, its notes, what was said on the bus, then the last thing it said.
 */
export function threadBubbles(thread: AgentThread, activity: JobActivityV1 | null | undefined, messages: readonly AgentMessage[]): ThreadBubble[] {
  const { node } = thread, entries = activity?.entries ?? [], out: ThreadBubble[] = [];
  const report = (name: 'brief' | 'notes') => entries.find(entry => entry.kind === 'report' && entry.name === name && entry.state === 'ok' && entry.text !== '');
  const brief = report('brief'), notes = report('notes');
  if (brief?.kind === 'report') out.push({ key: 'brief', side: 'other', label: `Brief${brief.truncated ? ' · truncated' : ''}`, when: '', text: brief.text, format: 'markdown' });
  entries.forEach((entry, index) => {
    if (entry.kind === 'event') out.push({ key: `event:${index}`, side: 'system', label: entry.event, when: eventTimeLabel(entry.at), text: entry.summary, format: 'plain' });
  });
  const commands = entries.filter(entry => entry.kind === 'command');
  if (commands.length > 0) out.push({
    key: 'commands', side: 'agent', format: 'mono', when: '',
    label: commands.length > COMMANDS_SHOWN ? `Ran ${plural(commands.length, 'command')} · last ${COMMANDS_SHOWN} shown` : `Ran ${plural(commands.length, 'command')}`,
    text: commands.slice(-COMMANDS_SHOWN).map(command => command.text).join('\n'),
  });
  const files = entries.find(entry => entry.kind === 'files');
  if (files?.kind === 'files' && files.state !== 'missing' && files.totals.files > 0) out.push({
    key: 'files', side: 'agent', format: 'mono', when: '',
    label: `Changed ${plural(files.totals.files, 'file')} · +${files.totals.added} −${files.totals.removed}${files.state === 'degraded' ? ' · partial' : ''}`,
    text: [...files.files.slice(0, FILES_SHOWN).map(file => file.path), ...(files.totals.files > FILES_SHOWN ? [`and ${files.totals.files - FILES_SHOWN} more`] : [])].join('\n'),
  });
  if (notes?.kind === 'report') out.push({ key: 'notes', side: 'agent', label: `Notes${notes.truncated ? ' · truncated' : ''}`, when: '', text: notes.text, format: 'markdown' });
  for (const m of threadMessages(thread, messages)) out.push({
    key: `bus:${m.id}`, side: m.from.name === node.id ? 'agent' : 'other', label: `${m.from.name} → ${m.to.name} · ${m.kind}`,
    when: eventTimeLabel(m.ts), text: m.summary, format: 'plain',
  });
  if (node.lastMessage !== null) out.push({ key: 'latest', side: 'agent', label: 'Latest', when: spoke(node), text: node.lastMessage, format: 'plain' });
  return out;
}

/** The session after (or before) `id` in the list, wrapping; the first one when `id` is not in it. */
export function stepThread(threads: readonly AgentThread[], id: string | null, delta: 1 | -1): string | null {
  if (threads.length === 0) return null;
  const at = threads.findIndex(thread => thread.node.id === id);
  return threads[at < 0 ? 0 : (at + delta + threads.length) % threads.length]!.node.id;
}
