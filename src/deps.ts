import type { Config } from './config/env';
import type { RedisClient } from './lib/redis';
import type { Fetcher } from './audit/fetcher';
import type { AuditService } from './audit/service';
import type { Cache } from './cache';
import type { RateLimiter } from './ratelimit';
import type { ConcurrencyGuard } from './lib/concurrency';

export interface AppDeps {
  config: Config;
  redis: RedisClient;
  fetcher: Fetcher;
  auditService: AuditService;
  cache: Cache;
  rateLimiter: RateLimiter;
  guard: ConcurrencyGuard;
}
