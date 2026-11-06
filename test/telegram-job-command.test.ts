import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStopCommand, parseReassignCommand, renderJobCommandReply, runTelegramJobCommand, type TelegramJobCommandDeps } from '../src/core/comms/telegram-job-command.js';
import { ReassignError } from '../src/core/fleet/runs-reassign.js';
import { stopJob } from '../src/core/fleet/job-stop.js';
import { reassignQueuedJobs } from '../src/core/fleet/runs-reassign.js';
import { handleSlashCommand } from '../src/core/comms/telegram-channel.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests, type InboundEvent } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

vi.mock('../src/core/fleet/job-stop.js', () => ({ stopJob: vi.fn() }));
vi.mock('../src/core/fleet/runs-reassign.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/core/fleet/runs-reassign.js')>();
  return { ...original, reassignQueuedJobs: vi.fn() };
});

const id = 'RQ-PHX-ABC01';
const stopped = { id, outcome: 'stopped' as const, pids: [101, 102], at: '2026-11-02T00:00:00Z' };
const moved = { v: 1 as const, generatedAt: stopped.at, applied: true, lane: 'devin', moved: [{ id, fromLane: 'claude', fromTier: 'work', toLane: 'devin', toTier: 'work' }], skipped: [], verified: true };
const deps = (): TelegramJobCommandDeps => ({ stopJob: vi.fn().mockResolvedValue(stopped), reassignQueuedJobs: vi.fn().mockResolvedValue(moved) });
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { chatId: '4242', botToken: 'fake' } } } as AshlrConfig;
const event: InboundEvent = { kind: 'text', fromChatId: '4242', senderUserId: 4242, privateChat: true, messageId: 10 };

describe('Telegram job commands', () => {
  it.each(['/stop RQ-PHX-ABC01', '/stop@somebot RQ-PHX-ABC01'])('parses %s', text => {
    expect(parseStopCommand(text)).toEqual({ id });
  });

  it.each(['RQ PHX ABC01', 'RQ/PHX/ABC01', '..', 'RQ-PHX-..', 'RQ-PHX-X;whoami', 'RQ-PHX-$(whoami)', 'RQ-PHX-X|cat'])('rejects unsafe ID %s before either action', async bad => {
    const actions = deps();
    for (const text of [`/stop ${bad}`, `/reassign ${bad} devin work`]) {
      expect(await runTelegramJobCommand(text, actions)).toMatchObject({ status: 'usage' });
    }
    expect(actions.stopJob).not.toHaveBeenCalled();
    expect(actions.reassignQueuedJobs).not.toHaveBeenCalled();
  });

  it('calls the stop action with attribution and renders stopped and absent jobs', async () => {
    const actions = deps();
    expect(renderJobCommandReply(await runTelegramJobCommand(`/stop ${id}`, actions))).toBe(`Stopped ${id} (2 processes).`);
    expect(actions.stopJob).toHaveBeenCalledWith(id, { by: 'telegram' });
    vi.mocked(actions.stopJob).mockResolvedValue({ ...stopped, outcome: 'not-running', pids: [] });
    expect(renderJobCommandReply(await runTelegramJobCommand(`/stop ${id}`, actions))).toBe(`${id} not running.`);
  });

  it('reassigns one job with force false and preserves an omitted tier', async () => {
    const actions = deps();
    expect(parseReassignCommand(`/reassign@somebot ${id} devin work`)).toEqual({ id, lane: 'devin', tier: 'work' });
    expect(renderJobCommandReply(await runTelegramJobCommand(`/reassign ${id} devin work`, actions))).toBe(`Moved ${id} to devin/work.`);
    expect(actions.reassignQueuedJobs).toHaveBeenCalledWith({ job: id, lane: 'devin', tier: 'work', apply: true, force: false }, { changedBy: 'telegram' });
    await runTelegramJobCommand(`/reassign ${id} devin`, actions);
    expect(actions.reassignQueuedJobs).toHaveBeenLastCalledWith({ job: id, lane: 'devin', tier: undefined, apply: true, force: false }, { changedBy: 'telegram' });
  });

  it.each(['lane-held', 'lane-down', 'tier-unknown', 'job-launched'] as const)('renders fixed refusal for %s', async code => {
    const actions = deps();
    vi.mocked(actions.reassignQueuedJobs).mockRejectedValue(new ReassignError(code));
    const reply = renderJobCommandReply(await runTelegramJobCommand(`/reassign ${id} devin work`, actions));
    expect(reply).toBe(`Reassign refused: ${{ 'lane-held': 'lane is held', 'lane-down': 'lane is down', 'tier-unknown': 'tier is unknown', 'job-launched': 'job already launched' }[code]}.`);
  });

  it.each(['stop', 'reassign'] as const)('never exposes thrown %s errors', async command => {
    const actions = deps();
    vi.mocked(actions.stopJob).mockRejectedValue(new Error('private filesystem detail'));
    vi.mocked(actions.reassignQueuedJobs).mockRejectedValue(new Error('private filesystem detail'));
    const reply = renderJobCommandReply(await runTelegramJobCommand(`/${command} ${id}${command === 'reassign' ? ' devin work' : ''}`, actions));
    expect(reply).toBe(command === 'stop' ? 'Stop failed: job stop unavailable.' : 'Reassign failed: job reassign unavailable.');
    expect(reply).not.toContain('private filesystem detail');
  });

  it('does not claim an unconfirmed move succeeded', async () => {
    const actions = deps();
    vi.mocked(actions.reassignQueuedJobs).mockResolvedValue({ ...moved, moved: [], verified: false });
    expect(await runTelegramJobCommand(`/reassign ${id} devin`, actions)).toEqual({ status: 'failed', command: 'reassign' });
  });
});

describe('Telegram job channel authorisation and replies', () => {
  let sent: Record<string, unknown>[];
  beforeEach(() => {
    vi.mocked(stopJob).mockReset().mockResolvedValue(stopped);
    vi.mocked(reassignQueuedJobs).mockReset().mockResolvedValue(moved);
    sent = [];
    let now = 0;
    setTelegramSendClockForTests({ now: () => now, sleep: async ms => { now += ms; } });
    setTelegramTransportForTests(async (_method, body) => { sent.push(body); return { ok: true, result: { message_id: 55 } }; });
  });
  afterEach(() => {
    setTelegramTransportForTests(null);
    setTelegramSendClockForTests(null);
  });

  it.each([
    { fromChatId: '9876' }, { fromChatId: undefined }, { senderUserId: 9876 },
    { senderUserId: undefined }, { privateChat: false }, { privateChat: undefined },
  ])('never reaches either action with wrong or missing identity %j', async evidence => {
    await handleSlashCommand({ ...event, ...evidence }, `/stop ${id}`, cfg);
    await handleSlashCommand({ ...event, ...evidence }, `/reassign ${id} devin work`, cfg);
    expect(stopJob).not.toHaveBeenCalled();
    expect(reassignQueuedJobs).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it.each([`/stop ${id}`, `/reassign ${id} devin work`])('replies in the authorised chat for %s', async text => {
    await handleSlashCommand(event, text, cfg);
    expect(sent.at(-1)).toMatchObject({ chat_id: '4242', text: text.startsWith('/stop') ? `Stopped ${id} (2 processes).` : `Moved ${id} to devin/work.`, reply_parameters: { message_id: 10 } });
  });

  it('returns usage before any action for malformed commands', async () => {
    await handleSlashCommand(event, '/stop ../bad', cfg);
    await handleSlashCommand(event, `/reassign ${id}`, cfg);
    expect(stopJob).not.toHaveBeenCalled();
    expect(reassignQueuedJobs).not.toHaveBeenCalled();
    expect(sent.map(row => row['text'])).toEqual(['Usage: /stop &lt;JOB-ID&gt;', 'Usage: /reassign &lt;JOB-ID&gt; &lt;lane&gt; [tier]']);
  });
});
