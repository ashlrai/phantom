import { describe, expect, it } from 'vitest';
import { compareOfflineReplay } from '../src/core/providers/coding-cli/replay-comparison.ts';

// Test data for our comparisons - let's create simpler and more appropriate test data
const sampleRows = [
  {
    rowId: 'row1',
    poolId: 'pool1',
    consumer: 'consumer1',
    action: 'action1',
    reward: 1.0,
    propensity: 0.5,
    predictions: {
      'action1': 0.8,
      'action2': 0.2
    }
  },
  {
    rowId: 'row2', 
    poolId: 'pool1',
    consumer: 'consumer1',
    action: 'action2',
    reward: 0.5,
    propensity: 0.3,
    predictions: {
      'action1': 0.3,
      'action2': 0.7
    }
  }
];

describe('compareOfflineReplay', () => {
  it('should return equal comparison when scores are equal', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        },
        'row2': {
          'action1': 0.3,
          'action2': 0.7
        }
      }
    };

    const policy2 = {
      id: 'policy2',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        },
        'row2': {
          'action1': 0.3,
          'action2': 0.7
        }
      }
    };

    const result = compareOfflineReplay(
      sampleRows,
      policy1,
      policy2,
      1,
      1e-3
    );
    
    expect(result.incumbentScore).toBeGreaterThan(0);
    expect(result.candidateScore).toBeGreaterThan(0);
    expect(result.comparison).toBe('equal');
    expect(result.sufficientRows).toBe(true);
    expect(result.candidateMinusIncumbent).toBe(0);
  });

  it('should return candidate-higher when candidate score is better', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        },
        'row2': {
          'action1': 0.3,
          'action2': 0.7
        }
      }
    };

    const policy2 = {
      id: 'policy2',
      predictions: {
        'row1': {
          'action1': 0.9,
          'action2': 0.1
        },
        'row2': {
          'action1': 0.2,
          'action2': 0.8
        }
      }
    };

    const result = compareOfflineReplay(
      sampleRows,
      policy1,
      policy2,
      1,
      1e-3
    );
    
    expect(result.incumbentScore).toBeGreaterThan(result.candidateScore);
    expect(result.comparison).toBe('candidate-higher');
    expect(result.sufficientRows).toBe(true);
    expect(result.candidateMinusIncumbent).toBeGreaterThan(0);
  });

  it('should return incumbent-higher when incumbent score is better', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {
        'row1': {
          'action1': 0.9,
          'action2': 0.1
        },
        'row2': {
          'action1': 0.2,
          'action2': 0.8
        }
      }
    };

    const policy2 = {
      id: 'policy2',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        },
        'row2': {
          'action1': 0.3,
          'action2': 0.7
        }
      }
    };

    const result = compareOfflineReplay(
      sampleRows,
      policy1,
      policy2,
      1,
      1e-3
    );
    
    expect(result.incumbentScore).toBeGreaterThan(result.candidateScore);
    expect(result.comparison).toBe('incumbent-higher');
    expect(result.sufficientRows).toBe(true);
    expect(result.candidateMinusIncumbent).toBeLessThan(0);
  });

  it('should return insufficient-data when rows is empty', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {}
    };

    const policy2 = {
      id: 'policy2',
      predictions: {}
    };

    const result = compareOfflineReplay(
      [],
      policy1,
      policy2,
      1,
      1e-3
    );
    
    expect(result.incumbentScore).toBeNull();
    expect(result.candidateScore).toBeNull();
    expect(result.comparison).toBe('insufficient-data');
    expect(result.sufficientRows).toBe(false);
    expect(result.candidateMinusIncumbent).toBeNull();
  });

  it('should handle insufficient rows correctly', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        }
      }
    };

    const policy2 = {
      id: 'policy2',
      predictions: {
        'row1': {
          'action1': 0.9,
          'action2': 0.1
        }
      }
    };

    const result = compareOfflineReplay(
      [sampleRows[0]], // Only one row
      policy1,
      policy2,
      2, // Need 2 rows but only have 1
      1e-3
    );
    
    expect(result.sufficientRows).toBe(false);
    expect(result.comparison).toBe('insufficient-data');
  });

  it('should handle the boundary case with exactly minRows', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        },
        'row2': {
          'action1': 0.3,
          'action2': 0.7
        }
      }
    };

    const policy2 = {
      id: 'policy2',
      predictions: {
        'row1': {
          'action1': 0.8,
          'action2': 0.2
        },
        'row2': {
          'action1': 0.3,
          'action2': 0.7
        }
      }
    };

    const result = compareOfflineReplay(
      sampleRows,
      policy1,
      policy2,
      2, // Exactly the number of rows
      1e-3
    );
    
    expect(result.sufficientRows).toBe(true);
    expect(result.comparison).toBe('equal');
  });

  it('should throw on invalid minRows', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {}
    };

    const policy2 = {
      id: 'policy2',
      predictions: {}
    };

    expect(() => {
      compareOfflineReplay(
        sampleRows,
        policy1,
        policy2,
        -1,
        1e-3
      );
    }).toThrow('minRows must be a positive finite integer');

    expect(() => {
      compareOfflineReplay(
        sampleRows,
        policy1,
        policy2,
        0,
        1e-3
      );
    }).toThrow('minRows must be a positive finite integer');

    expect(() => {
      compareOfflineReplay(
        sampleRows,
        policy1,
        policy2,
        1.5,
        1e-3
      );
    }).toThrow('minRows must be a positive finite integer');
  });

  it('should throw on invalid propensityFloor', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {}
    };

    const policy2 = {
      id: 'policy2',
      predictions: {}
    };

    expect(() => {
      compareOfflineReplay(
        sampleRows,
        policy1,
        policy2,
        1,
        -1e-3
      );
    }).toThrow('propensityFloor must be a finite positive number');

    expect(() => {
      compareOfflineReplay(
        sampleRows,
        policy1,
        policy2,
        1,
        0
      );
    }).toThrow('propensityFloor must be a finite positive number');

    expect(() => {
      compareOfflineReplay(
        sampleRows,
        policy1,
        policy2,
        1,
        Infinity
      );
    }).toThrow('propensityFloor must be a finite positive number');
  });

  it('should validate that rows is an array', () => {
    const policy1 = {
      id: 'policy1',
      predictions: {}
    };

    const policy2 = {
      id: 'policy2',
      predictions: {}
    };

    expect(() => {
      compareOfflineReplay(
        null as any,
        policy1,
        policy2,
        1,
        1e-3
      );
    }).toThrow('rows must be an array');
  });
});
