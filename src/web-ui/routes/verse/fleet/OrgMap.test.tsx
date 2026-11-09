import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrgMap } from './OrgMap.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';

describe('Fleet map', () => {
  it('shows unknown when the fleet snapshot is unavailable', () => {
    render(<OrgMap live={null} />);
    expect(screen.getByText('Fleet state unknown.')).toBeTruthy();
  });
  it('shows jobs below their lane', () => {
    const live = { generatedAt: 'now', state: 'running', lanes: [{ lane: 'codex' }],
      runs: [{ id: 'J1', title: 'Fix a bug', repo: 'phantom', lane: 'codex', phase: 'producing', endedAt: null, outcome: null }] } as FleetLiveSnapshotV1;
    render(<OrgMap live={live} />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Fix a bug')).toBeTruthy();
  });
});
