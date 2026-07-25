import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { Cache } from '../../src/cache';
import { testConfig } from '../../src/config/env';
import type { RedisClient } from '../../src/lib/redis';
import type { AuditResult } from '../../src/audit/types';

const sample: AuditResult = {
  url: 'https://x.com/',
  reachable: true,
  http: { status: 200, class: '2xx', ok: true },
  redirects: { count: 0, finalUrl: 'https://x.com/', chain: [] },
  timing: { dnsMs: null, connectMs: null, ttfbMs: 10, downloadMs: 5, totalMs: 20 },
  content: { contentType: 'text/html', bytes: 100, encoding: null, truncated: false },
  seo: null,
  checks: [],
  score: 80,
  fetchedAt: new Date(0).toISOString(),
};

function makeCache(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const redis = new RedisMock() as unknown as RedisClient;
  return { cache: new Cache(redis, config), redis };
}

const opts = { timeoutMs: 10000, maxRedirects: 5 };

describe('Cache.buildKey', () => {
  it('is stable for identical inputs', () => {
    const { cache } = makeCache();
    expect(cache.buildKey('https://x.com/', opts)).toBe(cache.buildKey('https://x.com/', opts));
  });

  it('differs when options differ', () => {
    const { cache } = makeCache();
    const a = cache.buildKey('https://x.com/', opts);
    const b = cache.buildKey('https://x.com/', { ...opts, timeoutMs: 5000 });
    expect(a).not.toBe(b);
  });

  it('differs for different URLs', () => {
    const { cache } = makeCache();
    expect(cache.buildKey('https://a.com/', opts)).not.toBe(cache.buildKey('https://b.com/', opts));
  });
});

describe('Cache get/set', () => {
  it('round-trips a stored result', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey('https://x.com/', opts);
    await cache.set(key, sample, 300, false);
    const hit = await cache.get(key);
    expect(hit?.result.score).toBe(80);
    expect(hit?.negative).toBe(false);
  });

  it('never reads or writes when caching is disabled', async () => {
    const { cache } = makeCache({ CACHE_ENABLED: 'false' });
    const key = cache.buildKey('https://x.com/', opts);
    await cache.set(key, sample, 300, false);
    expect(await cache.get(key)).toBeNull();
  });
});

describe('Cache.coalesce', () => {
  it('collapses concurrent identical computes into one', async () => {
    const { cache } = makeCache();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return sample;
    };
    const results = await Promise.all([
      cache.coalesce('k', fn),
      cache.coalesce('k', fn),
      cache.coalesce('k', fn),
    ]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.score === 80)).toBe(true);
  });
});
