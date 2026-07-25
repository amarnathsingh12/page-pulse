import { describe, expect, it } from 'vitest';
import { computeScore } from '../../src/audit/score';
import type { CheckResult } from '../../src/audit/types';

describe('computeScore', () => {
  it('returns null when no checks are applicable', () => {
    const checks: CheckResult[] = [{ id: 'x', weight: 2, verdict: 'n/a', detail: '' }];
    expect(computeScore(checks)).toBeNull();
  });

  it('excludes n/a from the denominator and treats warn as half credit', () => {
    const checks: CheckResult[] = [
      { id: 'a', weight: 2, verdict: 'pass', detail: '' },
      { id: 'b', weight: 2, verdict: 'warn', detail: '' },
      { id: 'c', weight: 1, verdict: 'fail', detail: '' },
      { id: 'd', weight: 5, verdict: 'n/a', detail: '' },
    ];
    expect(computeScore(checks)).toBe(60);
  });

  it('scores all-pass as 100', () => {
    const checks: CheckResult[] = [{ id: 'a', weight: 3, verdict: 'pass', detail: '' }];
    expect(computeScore(checks)).toBe(100);
  });
});
