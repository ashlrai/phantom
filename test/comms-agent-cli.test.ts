/**
 * CLI and MCP surface for the Comms role.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdCommsAgent } from '../src/cli/comms-agent.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { writeInbox } from '../src/core/comms-agent/store.js';

const roots: string[] = [];
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'comms-agent-cli-'));
  roots.push(root);
  return root;
};
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
  return { lines, restore: () => spy.mockRestore() };
}

describe('phm comms-agent', () => {
  it('status and drafts are JSON and name no lane', async () => {
    const runsDir = temp();
    await writeInbox(runsDir, [
      { id: 'person-1', transport: 'email', from: 'ada@example.com', subject: 'Question', body: 'Can you look?' },
    ]);
    const run = capture();
    expect(await cmdCommsAgent(['run', '--dir', runsDir, '--lanes', 'claude', '--json'])).toBe(0);
    const report = JSON.parse(run.lines.at(-1) ?? '{}') as { lane: string | null; grokRequired: boolean; sends: Array<{ status: string }> };
    expect(report.grokRequired).toBe(false);
    expect(report.lane === null || report.lane === 'claude').toBe(true);
    expect(report.lane).not.toBe('grok');
    expect(report.sends).toEqual([expect.objectContaining({ status: 'drafted', reason: expect.stringContaining('standing approval') })]);
    run.restore();

    const drafts = capture();
    expect(await cmdCommsAgent(['drafts', '--dir', runsDir, '--json'])).toBe(0);
    const listed = JSON.parse(drafts.lines.at(-1) ?? '{}') as { drafts: Array<{ recipient: string; status: string }> };
    expect(listed.drafts.map(draft => draft.recipient)).toEqual(['ada@example.com']);
    expect(listed.drafts.every(draft => draft.status === 'pending')).toBe(true);
    drafts.restore();

    const status = capture();
    expect(await cmdCommsAgent(['status', '--dir', runsDir, '--json'])).toBe(0);
    const snapshot = JSON.parse(status.lines.at(-1) ?? '{}') as { role: { id: string; lane: null; grokRequired: boolean }; sendsLogged: number };
    expect(snapshot.role.id).toBe('comms');
    expect(snapshot.role.lane).toBeNull();
    expect(snapshot.role.grokRequired).toBe(false);
    expect(snapshot.sendsLogged).toBe(0);
    status.restore();
  }, 60_000);

  it('exposes status, drafts and run as native MCP tools', async () => {
    const runsDir = temp();
    const previous = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runsDir;
    try {
      const status = await callNativeTool('ashlr_comms_agent_status', {});
      expect(status.isError).toBeUndefined();
      const text = status.content.map(part => part.type === 'text' ? part.text : '').join('');
      expect(JSON.parse(text)).toMatchObject({ role: { id: 'comms', lane: null, grokRequired: false } });
      const drafts = await callNativeTool('ashlr_comms_agent_drafts', {});
      expect(drafts.isError).toBeUndefined();
      const ran = await callNativeTool('ashlr_comms_agent_run', { lanes: 'local' });
      expect(ran.isError).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = previous;
    }
  }, 60_000);
});
