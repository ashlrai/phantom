/**
 * M28 `goals plan` keeps its "no model, zero network" promise for spec
 * authoring. Hermetic: specs land in a temp project dir (HOME/ASHLR_HOME are
 * relocated by test/setup/home.ts), and the provider client is mocked so no
 * real model endpoint is ever contacted.
 *
 * Covers:
 *   - planMilestoneSpec without allowCloud never constructs a provider client
 *     (no local-provider probe) and prints no `[spec-store] model call failed`
 *     line, yet still writes a v1 spec seeded with the milestone text.
 *   - planMilestoneSpec with allowCloud still drafts through the provider chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Goal, Milestone } from '../src/core/types.js';

const getActiveClientMock = vi.fn(async (): Promise<never> => {
  throw new Error('no local provider reachable');
});

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) =>
    (getActiveClientMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { planMilestoneSpec } from '../src/core/goals/planner.js';

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama', 'lmstudio'],
    },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function makeGoal(project: string): Goal {
  return {
    id: 'goal-no-model',
    objective: 'Ship offline planning',
    project,
    status: 'planning',
    milestones: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function makeMilestone(): Milestone {
  return {
    id: 'm0-design-abc123',
    title: 'Design the planner',
    detail: 'Clarify scope.',
    order: 0,
    status: 'pending',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

let project: string;
let stderrLines: string[];

beforeEach(() => {
  getActiveClientMock.mockClear();
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m28-no-model-'));
  stderrLines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('goals plan spec authoring: no model by default', () => {
  it('authors a deterministic spec without probing any provider', async () => {
    const spec = await planMilestoneSpec(makeGoal(project), makeMilestone(), makeConfig());

    expect(getActiveClientMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).not.toContain('[spec-store]');
    expect(stderrLines.join('')).not.toContain('model call failed');

    expect(spec.version).toBe(1);
    expect(spec.path.startsWith(path.join(project, '.ashlr', 'specs'))).toBe(true);
    const body = fs.readFileSync(spec.path, 'utf8');
    expect(body).toContain('Ship offline planning');
    expect(body).toContain('Design the planner');
    for (const section of [
      '## Context',
      '## North Star',
      '## Operating Principles',
      '## Pillars',
      '## Roadmap',
      '## Verification',
    ]) {
      expect(body).toContain(section);
    }
  });

  it('still drafts through the provider chain when allowCloud is set', async () => {
    await planMilestoneSpec(makeGoal(project), makeMilestone(), makeConfig(), {
      allowCloud: true,
    });
    expect(getActiveClientMock).toHaveBeenCalledTimes(1);
    expect((getActiveClientMock.mock.calls[0] as unknown[])[1]).toMatchObject({ allowCloud: true });
  });
});
