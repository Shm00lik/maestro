import { describe, it, expect } from 'vitest';
import { compareTaskKeys } from '../../src/core/types.js';

describe('compareTaskKeys', () => {
  it('sorts keys naturally, digit-less keys last', () => {
    expect(['final-review', 'T10', 'T1-review', 'T2', 'T1'].sort(compareTaskKeys))
      .toEqual(['T1', 'T1-review', 'T2', 'T10', 'final-review']);
  });
  it('orders digit-less keys by full string and is consistent', () => {
    expect(['zeta', 'alpha', 'T3'].sort(compareTaskKeys)).toEqual(['T3', 'alpha', 'zeta']);
    expect(compareTaskKeys('T1', 'T1')).toBe(0);
  });
});
