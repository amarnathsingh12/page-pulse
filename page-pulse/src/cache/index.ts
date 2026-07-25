import { createHash } from 'node:crypto';
import type { Config } from '../config/env';
import type { RedisClient } from '../lib/redis';
import type { AuditResult, FetcherOptions } from '../audit/types';

export const CACHE_SCHEMA_VERSION = 1;

export interface CacheHit {
  result: AuditResult;
  fetchedAt: number;
  ttl: number;
  negative: boolean;
}

interface StoredEntry {
  schema: number;
  result: AuditResult;
  fetchedAt: number;
  ttl: number;
  negative: boolean;
}

export class Cache {
  private readonly inflight = new Map<string, Promise<AuditResult>>();

  constructor(
    private readonly redis: RedisClient,
    private readonly config: Config,
  ) {}

  buildKey(normalized: string, opts: FetcherOptions): string {
    const urlHash = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
    const optHash = createHash('sha256')
      .update(JSON.stringify({ t: opts.timeoutMs, r: opts.maxRedirects }))
      .digest('hex')
      .slice(0, 16);
    return `pp:v${CACHE_SCHEMA_VERSION}:audit:${urlHash}:${optHash}`;
  }

  async get(key: string): Promise<CacheHit | null> {
    if (!this.config.CACHE_ENABLED) return null;
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const entry = JSON.parse(raw) as StoredEntry;
      if (entry.schema !== CACHE_SCHEMA_VERSION) return null;
      return {
        result: entry.result,
        fetchedAt: entry.fetchedAt,
        ttl: entry.ttl,
        negative: entry.negative,
      };
    } catch {
      return null;
    }
  }

  async set(key: string, result: AuditResult, ttlSeconds: number, negative: boolean): Promise<void> {
    if (!this.config.CACHE_ENABLED || ttlSeconds <= 0) return;
    try {
      const entry: StoredEntry = {
        schema: CACHE_SCHEMA_VERSION,
        result,
        fetchedAt: Date.now(),
        ttl: ttlSeconds,
        negative,
      };
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload) > this.config.CACHE_MAX_VALUE_BYTES) return;
      await this.redis.set(key, payload, 'EX', ttlSeconds);
    } catch {
      return;
    }
  }

  coalesce(key: string, fn: () => Promise<AuditResult>): Promise<AuditResult> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

export function cacheOutcome(
  result: AuditResult,
  config: Config,
): { negative: boolean; ttl: number } {
  const negative = !result.reachable || (result.http ? result.http.status >= 400 : true);
  return {
    negative,
    ttl: negative ? config.NEG_CACHE_TTL_SECONDS : config.CACHE_TTL_SECONDS,
  };
}
