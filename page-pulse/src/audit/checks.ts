import type { CheckResult, FetchOutcome, Seo } from './types';

const ONE_MB = 1048576;

export function runChecks(outcome: FetchOutcome, seo: Seo | null): CheckResult[] {
  const checks: CheckResult[] = [];

  if (!outcome.reachable) {
    checks.push({
      id: 'reachable',
      weight: 3,
      verdict: 'fail',
      detail: `unreachable: ${outcome.fetchError?.code ?? 'UNKNOWN'}`,
    });
    return checks;
  }

  checks.push({ id: 'reachable', weight: 3, verdict: 'pass', detail: 'target responded' });

  const http = outcome.http;
  if (http) {
    const verdict =
      http.class === '2xx'
        ? 'pass'
        : http.class === '3xx' || http.class === 'unknown'
          ? 'warn'
          : 'fail';
    checks.push({ id: 'http-status', weight: 3, verdict, detail: `${http.status} (${http.class})` });
  }

  const finalUrl = outcome.redirects.finalUrl;
  checks.push({
    id: 'https',
    weight: 2,
    verdict: finalUrl.startsWith('https://') ? 'pass' : 'fail',
    detail: finalUrl.startsWith('https://') ? 'served over https' : 'not served over https',
  });

  const ttfb = outcome.timing.ttfbMs;
  checks.push({
    id: 'ttfb',
    weight: 1,
    verdict: ttfb === null ? 'n/a' : ttfb < 600 ? 'pass' : ttfb <= 1500 ? 'warn' : 'fail',
    detail: ttfb === null ? 'not measured' : `${ttfb}ms`,
  });

  const rc = outcome.redirects.count;
  checks.push({
    id: 'redirect-count',
    weight: 1,
    verdict: rc <= 1 ? 'pass' : rc <= 3 ? 'warn' : 'fail',
    detail: `${rc} redirect(s)`,
  });

  const bytes = outcome.content?.bytes ?? 0;
  const truncated = outcome.content?.truncated ?? false;
  checks.push({
    id: 'page-weight',
    weight: 1,
    verdict: truncated ? 'fail' : bytes < ONE_MB ? 'pass' : bytes <= 2 * ONE_MB ? 'warn' : 'fail',
    detail: truncated ? `truncated at cap` : `${bytes} bytes`,
  });

  if (outcome.content?.isHtml && seo) {
    checks.push(titleCheck(seo));
    checks.push(metaCheck(seo));
    checks.push(h1Check(seo));
  } else {
    checks.push({ id: 'title-length', weight: 2, verdict: 'n/a', detail: 'not an HTML document' });
    checks.push({ id: 'meta-description', weight: 1, verdict: 'n/a', detail: 'not an HTML document' });
    checks.push({ id: 'h1-count', weight: 1, verdict: 'n/a', detail: 'not an HTML document' });
  }

  return checks;
}

function titleCheck(seo: Seo): CheckResult {
  if (!seo.title.present) {
    return { id: 'title-length', weight: 2, verdict: 'fail', detail: 'missing <title>' };
  }
  const len = seo.title.length;
  return {
    id: 'title-length',
    weight: 2,
    verdict: len >= 10 && len <= 60 ? 'pass' : 'warn',
    detail: `${len} chars (ideal 10-60)`,
  };
}

function metaCheck(seo: Seo): CheckResult {
  if (!seo.metaDescription.present) {
    return { id: 'meta-description', weight: 1, verdict: 'fail', detail: 'missing meta description' };
  }
  const len = seo.metaDescription.length;
  return {
    id: 'meta-description',
    weight: 1,
    verdict: len >= 50 && len <= 160 ? 'pass' : 'warn',
    detail: `${len} chars (ideal 50-160)`,
  };
}

function h1Check(seo: Seo): CheckResult {
  const count = seo.h1.count;
  return {
    id: 'h1-count',
    weight: 1,
    verdict: count === 1 ? 'pass' : count > 1 ? 'warn' : 'fail',
    detail: `${count} h1 element(s)`,
  };
}
