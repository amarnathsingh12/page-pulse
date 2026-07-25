import type { Config } from '../config/env';
import type { NormalizedTarget } from '../lib/url';
import { runChecks } from './checks';
import type { Fetcher } from './fetcher';
import { parseHtml } from './parser';
import { computeScore } from './score';
import type { AuditResult, FetcherOptions, Seo } from './types';

function graphemeLength(value: string): number {
  return Array.from(value).length;
}

export class AuditService {
  constructor(
    private readonly config: Config,
    private readonly fetcher: Fetcher,
  ) {}

  resolveOptions(input?: { timeoutMs?: number; maxRedirects?: number }): FetcherOptions {
    return {
      timeoutMs: input?.timeoutMs ?? this.config.FETCH_TOTAL_DEADLINE_MS,
      maxRedirects: input?.maxRedirects ?? this.config.MAX_REDIRECTS,
    };
  }

  async audit(target: NormalizedTarget, opts: FetcherOptions): Promise<AuditResult> {
    const outcome = await this.fetcher.fetch(target.url, opts);

    let seo: Seo | null = null;
    if (outcome.reachable && outcome.content?.isHtml && outcome.content.body) {
      const parsed = parseHtml(outcome.content.body, outcome.content.charset);
      seo = {
        title: {
          present: !!parsed.title && parsed.title.length > 0,
          length: parsed.title ? graphemeLength(parsed.title) : 0,
        },
        metaDescription: {
          present: parsed.metaDescription !== null && parsed.metaDescription !== '',
          length: parsed.metaDescription ? graphemeLength(parsed.metaDescription) : 0,
        },
        h1: { present: parsed.h1Count > 0, count: parsed.h1Count },
      };
    }

    const checks = runChecks(outcome, seo);
    const score = computeScore(checks);

    return {
      url: target.normalized,
      reachable: outcome.reachable,
      fetchError: outcome.fetchError,
      http: outcome.http,
      redirects: outcome.redirects,
      timing: outcome.timing,
      content: {
        contentType: outcome.content?.contentType ?? null,
        bytes: outcome.content?.bytes ?? 0,
        encoding: outcome.content?.encoding ?? null,
        truncated: outcome.content?.truncated ?? false,
      },
      seo,
      checks,
      score,
      fetchedAt: new Date().toISOString(),
    };
  }
}
