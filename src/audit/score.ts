import type { CheckResult, Verdict } from './types';

function credit(verdict: Verdict): number {
  if (verdict === 'pass') return 1;
  if (verdict === 'warn') return 0.5;
  return 0;
}

export function computeScore(checks: CheckResult[]): number | null {
  const applicable = checks.filter((c) => c.verdict !== 'n/a');
  const denominator = applicable.reduce((sum, c) => sum + c.weight, 0);
  if (denominator === 0) return null;
  const numerator = applicable.reduce((sum, c) => sum + c.weight * credit(c.verdict), 0);
  return Math.round((100 * numerator) / denominator);
}
