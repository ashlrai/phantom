import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Devin lane quota text', () => {
  it.each([
    ['weekly usage quota has been exhausted', true],
    ['Finished reviewing the weekly report', false],
  ])('holds only on quota exhaustion: %s', (line, held) => {
    const result = spawnSync('python3', ['-B', '-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, 'contrib/mac/tests')
from test_dispatchd import build, dead, held_lanes, lane_slot, launch_stubs, slots_of, tick
slots = held_lanes()
slots['devin'] = lane_slot()
with build(slots=slots) as directory:
    home = Path(directory).resolve()
    dead(home, 'RQ-QUOTA-TEXT', 'devin', [sys.argv[1]])
    result = tick(home, launch_stubs(home))
    assert result.returncode == 0, result.stderr
    print(json.dumps(slots_of(home)['devin']))
`, line], { encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const slot = JSON.parse(result.stdout);
    expect(slot.held === true).toBe(held);
    if (held) {
      expect(slot.held_by).toBe('autobackoff');
      expect(slot.held_reason).toContain('devin_usage_limit');
    }
  });
});
